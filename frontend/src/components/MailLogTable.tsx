/**
 * Dziennik wysyłek maili — jedna tabela dla dwóch miejsc:
 *   • Administracja → Poczta („Historia wysyłek”, wszystkie warianty),
 *   • okno podglądu maila zlecenia („Historia wysyłek tego zlecenia”).
 *
 * Wpis powstaje TAK SAMO przy sukcesie i przy porażce, więc kolumna „Status”
 * jest tu najważniejsza: „—” w historii znaczy „nikt nie próbował”, a czerwony
 * badge „nie doszło, oto powód”. Treść błędu bywa wielolinijkowym zrzutem z
 * SMTP, dlatego domyślnie siedzi zwinięta pod wierszem.
 */
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDateTime } from "@/components/admin-assistant/helpers";
import { cn } from "@/lib/utils";
import type { MailLogEntry, MailVariant } from "@/lib/api";

const MAIL_VARIANT_LABEL: Record<MailVariant, string> = {
  client: "Do klienta",
  internal: "Wewnętrzny",
  test: "Testowy",
  // Warianty modułu CMA → Grupy interwencyjne (jeden dziennik dla całej aplikacji).
  rfq: "Zapytanie o ofertę",
  termination: "Wypowiedzenie",
};

interface Props {
  items: MailLogEntry[];
  /** Wersja do okna dialogowego — mniejsza czcionka, bez kolumny „Temat”. */
  compact?: boolean;
  /** Komunikat przy pustej liście. */
  emptyText?: string;
  testid?: string;
}

export function MailLogTable({ items, compact, emptyText, testid }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={testid}>
        {emptyText ?? "Brak wysłanych wiadomości."}
      </p>
    );
  }

  // Kolumn jest tyle, ile rozpina wiersz z błędem — inaczej `colSpan` kłamie.
  const colCount = compact ? 5 : 6;

  return (
    <div className="overflow-x-auto" data-testid={testid}>
      <Table className={cn(compact && "text-xs")}>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">Data</TableHead>
            <TableHead className="whitespace-nowrap">Typ</TableHead>
            <TableHead>Do</TableHead>
            {!compact && <TableHead>Temat</TableHead>}
            <TableHead className="whitespace-nowrap">Status</TableHead>
            <TableHead className="whitespace-nowrap">Użytkownik</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => {
            const open = expanded.has(it.id);
            const recipients = [
              it.toAddr,
              it.ccAddr ? `DW: ${it.ccAddr}` : null,
              it.bccAddr ? `UDW: ${it.bccAddr}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Fragment key={it.id}>
                <TableRow>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {it.createdAt ? fmtDateTime(it.createdAt) : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {MAIL_VARIANT_LABEL[it.variant] ?? it.variant}
                  </TableCell>
                  <TableCell className="max-w-[18rem] truncate" title={recipients}>
                    {recipients || "—"}
                  </TableCell>
                  {!compact && (
                    <TableCell className="max-w-[20rem] truncate" title={it.subject}>
                      {it.subject || "—"}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap">
                    {it.status === "sent" ? (
                      <Badge variant="success" className="h-5 px-1.5 text-[10px]">
                        wysłano
                      </Badge>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => toggle(it.id)}
                        aria-expanded={open}
                        title={it.error ?? "Wysyłka nie powiodła się"}
                      >
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                          błąd
                        </Badge>
                        {it.error &&
                          (open ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          ))}
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {it.userLabel ?? "—"}
                  </TableCell>
                </TableRow>
                {open && it.error && (
                  <TableRow>
                    <TableCell colSpan={colCount} className="bg-destructive/5 text-destructive">
                      <span className="whitespace-pre-wrap break-words">{it.error}</span>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
