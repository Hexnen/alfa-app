/**
 * Edytor wzorca opisu — PEŁNA STRONA, tak samo jak edytor pakietu.
 *
 * Opis to gotowy kawałek dokumentu (warunki gwarancji, zakres wsparcia, warunki
 * płatności), który dokleja się na dole oferty. Pisze się go raz i używa przez
 * lata, więc pracuje się nad nim jak nad tekstem, a nie jak nad ustawieniem:
 * szerokie pole treści i OBOK niego podgląd tym samym rendererem, który pójdzie
 * na wydruk (`mdToHtml`). Dzięki temu „czy ta lista się rozjedzie" widać przy
 * pisaniu, a nie dopiero po wydrukowaniu oferty klientowi.
 *
 * KOPIA, NIE REFERENCJA: dołączenie opisu do oferty przepisuje jego treść do
 * dokumentu. Poprawka wzorca tutaj NIE zmienia ofert, które już wyszły — i tak
 * ma być, bo to, co dostał klient, musi dać się odtworzyć.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle,
  AlignLeft,
  ArrowLeft,
  Check,
  Eye,
  FileText,
  Loader2,
  Pin,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pillClass } from "@/lib/calendar-labels";
import { mdToHtml } from "@/lib/markdownLite";
import {
  OFFER_SECTION_CATEGORIES,
  type OfferSectionCategory,
  type OfferText,
  type OfferTextInput,
} from "@/lib/api";
import { ChoiceButton, Section } from "./offersUi";
import { OFFER_CATEGORY_META, OFFER_CATEGORY_UI } from "./offersShared";

interface TextEditorProps {
  /** Wzorzec do edycji; null = nowy. */
  text: OfferText | null;
  onSubmit: (data: OfferTextInput) => Promise<void>;
  onBack: () => void;
}

/**
 * Style podglądu markdownu. Tailwind zeruje `h3`, `ul` i `strong` (preflight),
 * więc bez tych klas podgląd byłby ścianą jednakowego tekstu i nie mówiłby nic
 * o tym, jak treść wygląda na papierze. Eksportowane, bo dokładnie ten sam
 * podgląd pokazuje dialog dołączania opisu na ofertę.
 */
export const MD_PREVIEW_CLASS = cn(
  "text-sm leading-relaxed",
  "[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3:first-child]:mt-0",
  // Bez wersalików: na wydruku `###` jest zwykłym, mniejszym nagłówkiem, a ten
  // podgląd obiecuje „co widzisz, to wyjdzie na papierze".
  "[&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:text-xs [&_h4]:font-semibold",
  "[&_p]:my-1.5 [&_p:first-child]:mt-0",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_strong]:font-semibold [&_em]:italic"
);

/**
 * Nagłówek bloku w podglądzie — lustro `.tb-title` z offerPrint.ts. Wersaliki
 * są tu po to, żeby tytuł bloku stał poziom WYŻEJ niż nagłówek `##` z treści,
 * a nie obok niego jako drugi nagłówek tego samego rzędu.
 */
export const MD_TITLE_CLASS =
  "mb-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground/75";

/**
 * Podgląd treści opisu. `dangerouslySetInnerHTML` jest tu bezpieczne: `mdToHtml`
 * escapuje wejście PRZED zamianą markerów markdownu, więc wklejony z Worda HTML
 * wychodzi z niej jako tekst, a nie jako znaczniki.
 */
export function MdPreview({ body, className }: { body: string; className?: string }) {
  const html = mdToHtml(body);
  if (!html) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Podgląd pojawi się, gdy wpiszesz treść.
      </p>
    );
  }
  return (
    <div
      className={cn(MD_PREVIEW_CLASS, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function TextEditor({ text, onSubmit, onBack }: TextEditorProps) {
  const [form, setForm] = useState({
    name: text?.name ?? "",
    category: (text?.category ?? "inne") as OfferSectionCategory,
    title: text?.title ?? "",
    body: text?.body ?? "",
    isDefault: text?.isDefault ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const problems: string[] = [];
  if (!form.name.trim()) problems.push("Opis musi mieć nazwę — po niej szuka się go w bibliotece.");
  if (!form.body.trim()) problems.push("Pusty opis nie ma czego dokleić do oferty.");

  /** Migawka do wykrywania niezapisanych zmian — jak w edytorze pakietu. */
  const snapshot = () => JSON.stringify(form);
  const initialSnapshot = useRef<string | null>(null);
  if (initialSnapshot.current === null) initialSnapshot.current = snapshot();
  const dirty = snapshot() !== initialSnapshot.current;

  const save = async () => {
    setAttempted(true);
    if (problems.length) {
      requestAnimationFrame(() =>
        alertRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        category: form.category,
        title: form.title.trim(),
        body: form.body,
        isDefault: form.isDefault,
      });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu opisu");
    } finally {
      setBusy(false);
    }
  };

  const requestBack = () => {
    if (dirty && !busy) setDiscardOpen(true);
    else onBack();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };

  const catMeta = OFFER_CATEGORY_META[form.category];
  const catUi = OFFER_CATEGORY_UI[form.category];

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      {/* --- Pasek: powrót, tytuł, stan, akcje --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={requestBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Biblioteka opisów
        </Button>
        <span
          className={cn("flex h-7 w-7 items-center justify-center rounded-md", catUi.soft)}
          aria-hidden
        >
          <AlignLeft className="h-4 w-4" />
        </span>
        <h2 className="truncate text-xl font-semibold">
          {form.name.trim() || (text ? "Opis" : "Nowy opis")}
        </h2>
        <span className={pillClass(catMeta.tone)}>{catMeta.label}</span>
        {form.isDefault && (
          <span className={pillClass("emerald")}>
            <Pin className="h-3 w-3" />
            na każdej ofercie
          </span>
        )}
        {dirty && <span className={pillClass("muted")}>niezapisane zmiany</span>}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={requestBack} disabled={busy}>
            Anuluj
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy}
            {...tip(problems[0] ?? (text ? "Zapisz zmiany we wzorcu" : "Utwórz opis"), {
              shortcut: "Ctrl+Enter",
            })}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            {busy ? "Zapisywanie…" : text ? "Zapisz" : "Utwórz opis"}
          </Button>
        </div>
      </div>

      {attempted && problems.length > 0 && (
        <div
          ref={alertRef}
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {(error ? [error, ...problems] : problems).map((m) => (
            <div key={m} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{m}</span>
            </div>
          ))}
        </div>
      )}
      {error && !problems.length && (
        <div
          ref={alertRef}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* --- Dane wzorca --- */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <Section id="txt-meta" icon={FileText} title="Wzorzec">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="txt-name">Nazwa *</Label>
                <Input
                  id="txt-name"
                  autoFocus
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="np. Warunki gwarancji — instalacje CCTV"
                  aria-invalid={attempted && !form.name.trim()}
                />
                <p className="text-[11px] text-muted-foreground">
                  Widoczna tylko dla nas — po niej szuka się wzorca w bibliotece.
                  Klient jej nie zobaczy.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Kategoria</Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {OFFER_SECTION_CATEGORIES.map((k) => (
                    <ChoiceButton
                      key={k}
                      active={form.category === k}
                      onClick={() => setForm((p) => ({ ...p, category: k }))}
                    >
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          form.category === k ? "bg-primary-foreground" : OFFER_CATEGORY_UI[k].bar
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{OFFER_CATEGORY_META[k].label}</span>
                    </ChoiceButton>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Tylko do porządkowania listy — opis z dowolnej kategorii da się
                  dołożyć do każdej oferty.
                </p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="txt-title">Nagłówek na ofercie</Label>
                <Input
                  id="txt-title"
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="np. Gwarancja i serwis"
                />
                <p className="text-[11px] text-muted-foreground">
                  To widzi klient nad treścią. Zostaw puste, a blok wydrukuje się
                  bez nagłówka — samą treścią.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Domyślność</Label>
                <label className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                    checked={form.isDefault}
                    onChange={(e) => setForm((p) => ({ ...p, isDefault: e.target.checked }))}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">Dokładaj do każdej nowej oferty</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      Nowa oferta dostanie kopię tej treści od razu przy tworzeniu —
                      na istniejących ofertach nic się nie zmieni, a z każdej z osobna
                      da się ją usunąć.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </Section>
        </CardContent>
      </Card>

      {/* --- Treść i podgląd obok siebie --- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <Section id="txt-body" icon={Type} title="Treść">
            <p className="text-[11px] text-muted-foreground">
              Prosty markdown: <code className="rounded bg-muted px-1">## nagłówek</code>,{" "}
              <code className="rounded bg-muted px-1">### podnagłówek</code>,{" "}
              <code className="rounded bg-muted px-1">- lista</code>,{" "}
              <code className="rounded bg-muted px-1">1. lista numerowana</code>,{" "}
              <code className="rounded bg-muted px-1">**pogrubienie**</code>,{" "}
              <code className="rounded bg-muted px-1">*kursywa*</code>. Pusta linia
              zaczyna nowy akapit.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <Textarea
                id="txt-body-input"
                rows={18}
                className="font-mono text-sm"
                value={form.body}
                onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                placeholder={"## Gwarancja\n\n- 24 miesiące na urządzenia\n- 12 miesięcy na robociznę\n\nNaprawy realizujemy w ciągu **48 godzin** od zgłoszenia."}
                aria-invalid={attempted && !form.body.trim()}
              />
              <div className="space-y-1.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" /> Podgląd wydruku
                </span>
                <div className="min-h-[10rem] rounded-md border bg-background px-3 py-2">
                  {form.title.trim() && (
                    <h3 className={MD_TITLE_CLASS}>{form.title.trim()}</h3>
                  )}
                  <MdPreview body={form.body} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Ten sam renderer składa wydruk oferty — co widać tutaj, to
                  wyjdzie na papierze.
                </p>
              </div>
            </div>
          </Section>
        </CardContent>
      </Card>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Porzucić zmiany w opisie?</AlertDialogTitle>
            <AlertDialogDescription>
              Treść i ustawienia wzorca nie zostaną zapisane.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Wróć do edycji</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardOpen(false);
                onBack();
              }}
            >
              Porzuć
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
