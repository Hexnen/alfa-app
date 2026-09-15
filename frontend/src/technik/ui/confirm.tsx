import type { ComponentProps, ReactNode } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * POTWIERDZENIE — wyłącznie dla operacji NIEODWRACALNYCH (podpis klienta,
 * porzucenie niezapisanego protokołu). Zmiana statusu zlecenia idzie od razu,
 * z toastem — dodatkowe pytanie tylko spowalniałoby pracę u klienta.
 *
 * Okno jest centrowane na każdej szerokości (arkusz dolny da się zbyt łatwo
 * odrzucić gestem), ale NIE zakładamy już, że zawsze jest krótkie: lista
 * kontaktów w „Do kogo zadzwonić?” miała na telefonie w poziomie (844×390)
 * 493 px przy 390 px ekranu i wychodziła poza kadr górą i dołem — tytuł
 * i „Anuluj” były nieosiągalne. Stąd wyśrodkowanie flexem zamiast
 * `translate`, własny `max-h` i scroll wewnątrz okna.
 */
export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/50" />
      {/* Warstwa centrująca przepuszcza dotyk (`pointer-events-none`), żeby
          nakładka Radiksa nadal łapała kliknięcia poza oknem. */}
      <div className="pointer-events-none fixed inset-0 z-[81] flex items-center justify-center">
        <AlertDialogPrimitive.Content
          className={cn(
            "pointer-events-auto my-4 flex max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] flex-col gap-3",
            "overflow-y-auto overscroll-contain rounded-xl border bg-card p-4 text-card-foreground shadow-2xl outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Content>
      </div>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-lg font-semibold leading-tight", className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline", size: "lg" }), className)}
      {...props}
    />
  );
}

export function AlertDialogAction({
  className,
  variant = "destructive",
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & {
  variant?: "default" | "destructive";
}) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant, size: "lg" }), className)}
      {...props}
    />
  );
}

/** Gotowe potwierdzenie w jednym wywołaniu — tyle wystarcza w 90% miejsc. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Usuń",
  cancelLabel = "Anuluj",
  variant = "destructive",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
