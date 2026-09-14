/**
 * Jeden podgląd dokumentu umowy dla wszystkich paneli — wybiera komponent po
 * RODZAJU PLIKU, a nie po tym, skąd pochodzi wpis.
 *
 * Rejestr, drafty i karta obiektu pokazują dziś dwa rodzaje dokumentów: DOCX
 * złożony z wzoru Worda (`DocxPreview`, z kolorowaniem pól) i wgrany PDF
 * (`PdfPreview`, wbudowana przeglądarka). Bez tego rozgałęzienia każdy panel
 * pisałby ten sam warunek u siebie, a `previewSrc`/`fieldLegend` — bez sensu
 * dla PDF-a — musiałby być wszędzie ręcznie wyłączany.
 *
 * `kind === null` (umowa bez dokumentu) trafia do `DocxPreview`: jego stan
 * pusty jest tu właściwym ekranem, bo to on niesie tekst „nie ma czego pokazać”
 * razem z ewentualnym przyciskiem naprawczym.
 */
import type { ReactNode } from "react";
import { DocxPreview } from "./DocxPreview";
import { PdfPreview } from "./PdfPreview";

interface Props {
  /** Z `fileKind` umowy albo draftu; `null` = brak dokumentu. */
  kind: "docx" | "pdf" | null;
  url: string | null;
  version?: string | number | null;
  downloadUrl?: string | null;
  title?: ReactNode;
  actions?: ReactNode;
  notice?: ReactNode;
  emptyText?: string;
  emptyAction?: ReactNode;
  /** Tylko DOCX: adres wariantu z kolorowaniem pól (`&preview=1`). */
  previewSrc?: string | null;
  /** Tylko DOCX: legenda kolorów pól nad dokumentem. */
  fieldLegend?: boolean;
  className?: string;
}

export function ContractPreview({ kind, previewSrc = null, fieldLegend = false, ...rest }: Props) {
  if (kind === "pdf") return <PdfPreview {...rest} />;
  return <DocxPreview {...rest} previewSrc={previewSrc} fieldLegend={fieldLegend} />;
}
