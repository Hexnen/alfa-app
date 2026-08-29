import { useState } from "react";
import { Ban, Check, Download, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { warehouseApi, type WarehouseDef, type WarehouseDocument } from "@/lib/api";
import {
  DOC_STATUS_META,
  DOC_TYPE_META,
  fmtDate,
  fmtDateTime,
  fmtPln,
  fmtQty,
  warehouseLabel,
} from "./warehouseShared";
import { pillClass } from "@/lib/calendar-labels";

interface WarehouseDocumentDetailsProps {
  open: boolean;
  onClose: () => void;
  /** Pełny dokument (z pozycjami) z GET /warehouse/documents/:id. */
  document: WarehouseDocument | null;
  warehouses: WarehouseDef[];
  editable: boolean;
  onConfirm: (doc: WarehouseDocument) => Promise<void>;
  onCancelDocument: (doc: WarehouseDocument) => Promise<void>;
  onDelete: (doc: WarehouseDocument) => Promise<void>;
  /** Otwiera formularz edycji szkicu (tylko status draft). */
  onEdit: (doc: WarehouseDocument) => void;
}

export function WarehouseDocumentDetails({
  open,
  onClose,
  document: doc,
  warehouses,
  editable,
  onConfirm,
  onCancelDocument,
  onDelete,
  onEdit,
}: WarehouseDocumentDetailsProps) {
  const [busy, setBusy] = useState(false);

  if (!doc) return null;

  const typeMeta = DOC_TYPE_META[doc.docType];
  const statusMeta = DOC_STATUS_META[doc.status];

  const run = async (fn: () => Promise<void>, fallbackMsg: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : fallbackMsg);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadInvoice = () =>
    run(async () => {
      const res = await warehouseApi.getDocumentInvoice(doc.id);
      const file = res.data;
      if (!file?.data) throw new Error("Brak załącznika faktury.");
      const a = window.document.createElement("a");
      a.href = file.data;
      a.download = file.fileName || "faktura";
      window.document.body.appendChild(a);
      a.click();
      a.remove();
    }, "Błąd pobierania faktury");

  const handleConfirm = () => {
    if (
      !window.confirm(
        "Zatwierdzić dokument? Zostanie nadany numer, a stany magazynowe zostaną zaksięgowane."
      )
    )
      return;
    run(() => onConfirm(doc), "Błąd zatwierdzania dokumentu");
  };

  const handleCancel = () => {
    if (
      !window.confirm(
        "Anulować dokument (storno)? Zaksięgowane ruchy magazynowe zostaną cofnięte, a stany wrócą do wartości sprzed zatwierdzenia."
      )
    )
      return;
    run(() => onCancelDocument(doc), "Błąd anulowania dokumentu");
  };

  const handleDelete = () => {
    if (!window.confirm("Usunąć szkic dokumentu? Tej operacji nie można cofnąć."))
      return;
    run(() => onDelete(doc), "Błąd usuwania dokumentu");
  };

  const meta: { label: string; value: React.ReactNode }[] = [
    { label: "Data wystawienia", value: fmtDate(doc.issuedAt) },
  ];
  if (doc.docType === "PZ") {
    meta.push({
      label: "Magazyn docelowy",
      value: warehouseLabel(warehouses, doc.warehouseToId, doc.warehouseToName),
    });
    if (doc.contractorName)
      meta.push({ label: "Dostawca", value: doc.contractorName });
    if (doc.invoiceNumber)
      meta.push({ label: "Nr faktury", value: doc.invoiceNumber });
  } else if (doc.docType === "MM") {
    meta.push({
      label: "Z magazynu",
      value: warehouseLabel(warehouses, doc.warehouseFromId, doc.warehouseFromName),
    });
    meta.push({
      label: "Do magazynu",
      value: warehouseLabel(warehouses, doc.warehouseToId, doc.warehouseToName),
    });
  } else {
    meta.push({
      label: "Magazyn źródłowy",
      value: warehouseLabel(warehouses, doc.warehouseFromId, doc.warehouseFromName),
    });
    if (doc.contractorName)
      meta.push({ label: "Odbiorca", value: doc.contractorName });
  }
  if (doc.confirmedAt)
    meta.push({ label: "Zatwierdzono", value: fmtDateTime(doc.confirmedAt) });
  if (doc.createdBy) meta.push({ label: "Utworzył", value: doc.createdBy });

  const hasPrices = (doc.items ?? []).some((i) => i.unitPrice != null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{doc.docNumber || "Szkic dokumentu"}</span>
            <span
              className={pillClass(typeMeta.tone)}
            >
              {typeMeta.label}
            </span>
            <span
              className={pillClass(statusMeta.tone)}
            >
              {statusMeta.label}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {meta.map((m) => (
              <div key={m.label} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{m.label}</dt>
                <dd className="text-right font-medium">{m.value}</dd>
              </div>
            ))}
          </dl>

          {doc.notes && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Uwagi
              </div>
              {doc.notes}
            </div>
          )}

          {(doc.hasInvoiceFile || doc.invoiceFileName) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={handleDownloadInvoice}
            >
              <Download className="mr-1 h-4 w-4" />
              Pobierz fakturę
              {doc.invoiceFileName ? ` (${doc.invoiceFileName})` : ""}
            </Button>
          )}

          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Lp.</th>
                  <th className="px-3 py-2 font-medium">Towar</th>
                  <th className="px-3 py-2 text-right font-medium">Ilość</th>
                  {hasPrices && (
                    <th className="px-3 py-2 text-right font-medium">
                      Cena jedn.
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {(doc.items ?? []).map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">
                      {item.positionNo}
                    </td>
                    <td className="px-3 py-2">{item.itemName ?? `#${item.itemId}`}</td>
                    <td className="px-3 py-2 text-right">
                      {fmtQty(item.quantity)} {item.itemUnit ?? ""}
                    </td>
                    {hasPrices && (
                      <td className="px-3 py-2 text-right">
                        {item.unitPrice != null ? fmtPln(item.unitPrice) : "—"}
                      </td>
                    )}
                  </tr>
                ))}
                {(doc.items ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={hasPrices ? 4 : 3}
                      className="px-3 py-4 text-center text-muted-foreground"
                    >
                      Brak pozycji
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Zamknij
          </Button>
          {editable && doc.status === "draft" && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onEdit(doc)}
              >
                <Pencil className="mr-1 h-4 w-4" /> Edytuj
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={handleDelete}
              >
                <Trash2 className="mr-1 h-4 w-4" /> Usuń
              </Button>
              <Button type="button" disabled={busy} onClick={handleConfirm}>
                <Check className="mr-1 h-4 w-4" /> Zatwierdź
              </Button>
            </>
          )}
          {editable && doc.status === "confirmed" && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={handleCancel}
            >
              <Ban className="mr-1 h-4 w-4" /> Anuluj (storno)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
