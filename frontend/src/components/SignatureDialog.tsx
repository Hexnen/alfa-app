import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import SignaturePad from "signature_pad";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Eraser, Check, X } from "lucide-react";

interface SignatureDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (signaturePng: string, signerName: string) => Promise<void>;
  defaultSignerName?: string;
}

/**
 * Pełnoekranowe pole podpisu palcem (jak u kuriera).
 * Osobny (zagnieżdżony) dialog Radixa — na pełny viewport, z blokadą
 * przewijania; canvas skalowany do devicePixelRatio, a przy obrocie ekranu
 * podpis jest zachowywany wektorowo (toData/fromData).
 */
export function SignatureDialog({
  open,
  onClose,
  onSave,
  defaultSignerName = "",
}: SignatureDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [signerName, setSignerName] = useState(defaultSignerName);
  const [isEmpty, setIsEmpty] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let pad: SignaturePad | null = null;
    let cancelled = false;

    // Radix montuje treść dialogu chwilę po zmianie `open` — czekamy na canvas.
    const init = () => {
      const canvas = canvasRef.current;
      if (cancelled) return;
      if (!canvas || canvas.offsetWidth === 0) {
        requestAnimationFrame(init);
        return;
      }
      pad = new SignaturePad(canvas, {
        minWidth: 1,
        maxWidth: 3,
        penColor: "#1c2733",
      });
      padRef.current = pad;
      pad.addEventListener("endStroke", () =>
        setIsEmpty(padRef.current?.isEmpty() ?? true)
      );
      resize();
    };

    const resize = () => {
      const canvas = canvasRef.current;
      const p = padRef.current;
      if (!canvas || !p) return;
      const data = p.toData();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      p.clear();
      if (data.length) p.fromData(data);
      setIsEmpty(p.isEmpty());
    };

    init();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      padRef.current?.off();
      padRef.current = null;
      setIsEmpty(true);
    };
  }, [open]);

  const clear = () => {
    padRef.current?.clear();
    setIsEmpty(true);
  };

  const save = async () => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) return;
    setSaving(true);
    try {
      await onSave(pad.toDataURL("image/png"), signerName.trim());
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu podpisu");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="fixed inset-0 z-[100] flex flex-col overscroll-none bg-white outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            Podpis zleceniodawcy
          </DialogPrimitive.Title>

          <div className="flex items-center gap-3 border-b px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Podpis zleceniodawcy</div>
              <div className="text-xs text-muted-foreground">
                Podpisz palcem w polu poniżej (najlepiej w poziomie)
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Zamknij"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          <div className="px-4 pt-2">
            <Input
              placeholder="Imię i nazwisko podpisującego"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              className="h-10 text-base"
            />
          </div>

          <div className="relative m-3 flex-1 overflow-hidden rounded-lg border-2 border-dashed border-muted-foreground/40 bg-slate-50">
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full"
              style={{ touchAction: "none", overscrollBehavior: "none" }}
            />
            <div className="pointer-events-none absolute inset-x-8 bottom-10 border-b border-muted-foreground/40" />
            {isEmpty && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/60">
                Miejsce na podpis
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
            <Button variant="outline" onClick={clear} disabled={isEmpty}>
              <Eraser className="h-4 w-4 mr-2" />
              Wyczyść
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button onClick={save} disabled={isEmpty || saving}>
              <Check className="h-4 w-4 mr-2" />
              {saving ? "Zapisywanie…" : "Zapisz podpis"}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
