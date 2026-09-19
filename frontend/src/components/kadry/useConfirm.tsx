// Hook obsługi wspólnego okna potwierdzenia Kadr.
//
// Osobny plik od samego okna, bo plik komponentu, który eksportuje też hooka,
// wypada z React Fast Refresh (reguła react-refresh/only-export-components).
import { useState } from "react";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/** Stan okna potwierdzenia — `ask(...)` otwiera, `dialog` wstawia się w drzewo. */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  return {
    ask: (req: ConfirmRequest) => setRequest(req),
    dialog: <ConfirmDialog request={request} onClose={() => setRequest(null)} />,
  };
}
