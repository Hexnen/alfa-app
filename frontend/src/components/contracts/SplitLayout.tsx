/**
 * Układ „lista po lewej, podgląd po prawej” — wspólny dla trzech paneli
 * zakładki Umowy (rejestr, drafty, wzory).
 *
 * DLACZEGO WSPÓLNY KOMPONENT. Wszystkie trzy panele robią to samo: wybierasz
 * pozycję z listy, po prawej widzisz jej dokument. Gdyby każdy panel trzymał
 * własną siatkę i własne `sticky`, po pierwszej zmianie proporcji rozjechałyby
 * się względem siebie.
 *
 * PROPORCJE PÓŁ NA PÓŁ. Kusiło, żeby dać podglądowi więcej (kartka A4 im
 * szersza kolumna, tym mniej skalowana), ale to lista płaci za to najwięcej:
 * tabela z numerem, obiektem, kwotą i statusem poniżej ~600 px zaczyna się
 * zawijać albo uciekać w bok. Równy podział daje obu stronom tyle, że jedna
 * mieści komplet kolumn, a druga czyta się bez zbliżania.
 *
 * PODGLĄD JEST `sticky`. Listy bywają długie; bez tego przewinięcie do
 * dwudziestej umowy zostawiałoby podgląd wysoko poza ekranem. Poniżej `lg`
 * (tablet, telefon) wracamy do jednej kolumny i podglądu POD listą — obok
 * siebie nie zmieściłyby się w sposób, w którym cokolwiek dałoby się przeczytać.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Lewa kolumna: filtry + lista/tabela. */
  list: ReactNode;
  /** Prawa kolumna: zwykle `DocxPreview`. */
  preview: ReactNode;
  /** Nad obiema kolumnami (np. pasek filtrów na całą szerokość). */
  header?: ReactNode;
  className?: string;
  testid?: string;
}

export function SplitLayout({ list, preview, header, className, testid }: Props) {
  return (
    <div className={cn("space-y-3", className)} data-testid={testid}>
      {header}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0">{list}</div>
        <div className="min-w-0">
          {/* `top-4` mija się z paskiem układu; `max-h` trzyma podgląd w oknie,
              żeby to on miał pasek przewijania, a nie cała strona. */}
          <div className="lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100vh-6rem)] lg:flex-col">
            {preview}
          </div>
        </div>
      </div>
    </div>
  );
}
