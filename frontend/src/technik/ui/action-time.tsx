import { useState, type ReactNode } from "react";
import { Clock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "./confirm";
import { isFutureStamp } from "../lib/dates";

/**
 * KIEDY TO SIĘ STAŁO — okno „Teraz / Inna godzina” dla „Rozpocznij” i „Zakończ”.
 *
 * Domyślna droga to JEDEN tap w duże „Teraz”: tak wygląda 95% przypadków, gdy
 * technik klika stojąc u klienta. „Inna godzina” dokłada natywne pola daty
 * i czasu (systemowy picker — własny kalendarz na dotyku przegrywa z tym, co
 * technik zna z telefonu); od tego są zaległości wpisywane wieczorem w aucie.
 *
 * To okno ZASTĘPUJE dotychczasowe potwierdzenie przy „Zakończ”: jeden krok,
 * nie dwa. Zgody na coś nieodwracalnego tu nie ma — znacznik da się poprawić.
 */
export function ActionTimeDialog({
  open,
  onOpenChange,
  busy,
  ...body
}: ActionTimeBodyProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {/* Treść żyje w osobnym komponencie, bo Radix montuje ją dopiero przy
            otwarciu: pola dostają wtedy ŚWIEŻĄ godzinę „teraz”, bez ręcznego
            zerowania stanu w efekcie. */}
        <ActionTimeBody {...body} busy={busy} onCancel={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ActionTimeBodyProps {
  title: ReactNode;
  description?: ReactNode;
  nowLabel?: string;
  confirmLabel?: string;
  /** Dzień zlecenia (`YYYY-MM-DD`) — podpowiedź, gdy robota była innego dnia. */
  defaultDay?: string;
  busy?: boolean;
  /** `at` = lokalne „RRRR-MM-DDTGG:MM”; `undefined` = teraz. */
  onSubmit: (at?: string) => void;
}

function ActionTimeBody({
  title,
  description,
  nowLabel = "Teraz",
  confirmLabel = "Zapisz",
  defaultDay,
  busy,
  onSubmit,
  onCancel,
}: ActionTimeBodyProps & { onCancel: () => void }) {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

  const [custom, setCustom] = useState(false);
  // Dzień zlecenia wygrywa z dzisiejszym TYLKO wstecz: jeśli robota była
  // wczoraj, to wczorajsza data jest tą, którą technik chce poprawić. Przy
  // zleceniu z JUTRA podpowiadanie dnia zlecenia ustawiało okno na przyszłość,
  // a backend przyszłych znaczników nie przyjmuje — technik dostawał 400 za
  // wartość, której sam nie wpisał.
  const [day, setDay] = useState(defaultDay && defaultDay < today ? defaultDay : today);
  const [time, setTime] = useState(`${p(now.getHours())}:${p(now.getMinutes())}`);

  const at = `${day}T${time.slice(0, 5)}`;
  const shaped = /^\d{4}-\d{2}-\d{2}$/.test(day) && /^\d{2}:\d{2}/.test(time);
  // Ta sama reguła co na serwerze, tylko pokazana od razu: znacznik z przyszłości
  // jest odrzucany. Pięć minut luzu bierze na siebie rozjazd zegara tabletu.
  const future = shaped && isFutureStamp(at);
  const canSave = shaped && !future;

  return (
    <>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      {description && <AlertDialogDescription>{description}</AlertDialogDescription>}

      {!custom ? (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="h-12 w-full text-base"
            disabled={busy}
            data-testid="action-time-now"
            onClick={() => onSubmit(undefined)}
          >
            <Clock className="mr-2 h-5 w-5" />
            {nowLabel}
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full"
            disabled={busy}
            data-testid="action-time-custom"
            onClick={() => setCustom(true)}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Inna godzina
          </Button>
          <Button variant="ghost" className="h-11 w-full" disabled={busy} onClick={onCancel}>
            Anuluj
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="at-day">Data</Label>
              <Input
                id="at-day"
                type="date"
                value={day}
                max={today}
                onChange={(e) => setDay(e.target.value)}
                className="h-12 text-base"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="at-time">Godzina</Label>
              <Input
                id="at-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-12 text-base tabular-nums"
              />
            </div>
          </div>
          {future && (
            <p role="alert" data-testid="action-time-error" className="text-sm text-red-700 dark:text-red-400">
              Godzina z przyszłości
            </p>
          )}
          {/* `shrink-0` + `sm:flex-1`, a nie samo `flex-1`: poniżej 640 px oś
              główna jest PIONOWA, więc `flex: 1 1 0%` liczyło wysokość od zera
              i nadpisywało `h-12` — „Zapisz” miał na telefonie 24 px. */}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              size="lg"
              className="h-12 shrink-0 text-base sm:flex-1"
              disabled={busy || !canSave}
              data-testid="action-time-save"
              onClick={() => onSubmit(at)}
            >
              {confirmLabel}
            </Button>
            <Button variant="outline" className="h-11 shrink-0 sm:flex-1" disabled={busy} onClick={() => setCustom(false)}>
              Wstecz
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
