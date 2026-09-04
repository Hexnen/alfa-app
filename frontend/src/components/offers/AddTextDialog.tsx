/**
 * Wybór opisów do dołożenia na ofertę — w tym samym języku wizualnym co dialog
 * pakietu: kolorowy pasek kategorii, kafel ikony, sekcje i przyklejona stopka.
 *
 * Trzy różnice wobec `AddPackageDialog`, i każda wynika z tego, czym opisy są:
 *  - KATEGORIA NIE JEST NARZUCONA z zewnątrz. Pakiet dodaje się z paska „+ CCTV",
 *    więc lista jest z góry zawężona; „warunki płatności" pasują do każdej oferty
 *    niezależnie od tego, co się na niej instaluje. Kategoria jest więc filtrem,
 *    domyślnie wyłączonym.
 *  - WYBÓR WIELOKROTNY. Na dole oferty stają zwykle trzy–cztery bloki naraz
 *    (gwarancja, wsparcie, płatności), a otwieranie dialogu cztery razy pod rząd
 *    było pracą bez powodu.
 *  - PODGLĄD TREŚCI ostatnio zaznaczonego wzorca — nazwa „Warunki serwisu 2024"
 *    nie mówi, czy to ta wersja z czasem reakcji 24 czy 48 godzin.
 *
 * Dołożenie KOPIUJE treść do dokumentu; późniejsza poprawka wzorca w bibliotece
 * nie ruszy oferty, którą klient już dostał.
 */
import { useEffect, useMemo, useState } from "react";
import { AlignLeft, Check, Eye, Filter, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { pillClass } from "@/lib/calendar-labels";
import { OFFER_SECTION_CATEGORIES, type OfferSectionCategory, type OfferText } from "@/lib/api";
import { OFFER_CATEGORY_META, OFFER_CATEGORY_UI } from "./offersShared";
import { ChoiceButton, Section } from "./offersUi";
import { MD_TITLE_CLASS, MdPreview } from "./TextEditor";

interface AddTextDialogProps {
  open: boolean;
  onClose: () => void;
  texts: OfferText[];
  onAdd: (textIds: number[]) => Promise<void>;
}

/** Pierwsze ~110 znaków surowej treści — tyle wystarczy, żeby poznać wzorzec na liście. */
const excerpt = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
};

/** Polska liczba mnoga na przycisku: 1 opis, 2–4 opisy, 5+ opisów (12–14 to wyjątek). */
const textsPlural = (n: number): string => {
  const t = n % 10;
  const h = n % 100;
  if (n === 1) return "opis";
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return "opisy";
  return "opisów";
};

export function AddTextDialog({ open, onClose, texts, onAdd }: AddTextDialogProps) {
  const [filter, setFilter] = useState<OfferSectionCategory | "">("");
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  // Każde otwarcie zaczyna od czystej listy — inaczej zaznaczenia z poprzedniego
  // dołożenia wjechałyby na ofertę po raz drugi.
  useEffect(() => {
    if (open) {
      setSelected([]);
      setFilter("");
    }
  }, [open]);

  const active = useMemo(() => texts.filter((t) => t.active), [texts]);
  const visible = useMemo(
    () => (filter ? active.filter((t) => t.category === filter) : active),
    [active, filter]
  );

  /** Podgląd pokazuje OSTATNIO zaznaczony wzorzec — ten, o którym użytkownik właśnie myśli. */
  const previewId = selected.length ? selected[selected.length - 1] : null;
  const preview = previewId === null ? null : active.find((t) => t.id === previewId) ?? null;

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      await onAdd(selected);
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Nie udało się dodać opisów");
    } finally {
      setBusy(false);
    }
  };

  // Bez narzuconej kategorii pasek bierze kolor z filtra; „wszystkie" chodzą
  // w neutralnej szarości kategorii „inne".
  const ui = OFFER_CATEGORY_UI[filter || "inne"];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && selected.length > 0) {
            e.preventDefault();
            void submit();
          }
        }}
        className={cn(
          "flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0",
          "sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-lg",
          "motion-reduce:animate-none motion-reduce:transition-none"
        )}
      >
        <div className="relative shrink-0 border-b px-5 pb-3 pr-12 pt-4">
          <div className={cn("absolute inset-x-0 top-0 h-1", ui.bar)} aria-hidden />
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                ui.soft
              )}
              aria-hidden
            >
              <AlignLeft className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold leading-tight">
                <span className="truncate">Dodaj opis</span>
                <span className={pillClass("muted")}>{active.length} w bibliotece</span>
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
                Treść zostanie skopiowana do oferty — późniejsza poprawka wzorca nie
                zmieni tego dokumentu.
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="space-y-4 px-5 py-4">
            {active.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                Biblioteka opisów jest pusta. Wzorce zakłada się w zakładce „Opisy"
                na liście ofert — albo dodaj tutaj własny opis i napisz go od ręki.
              </p>
            ) : (
              <>
                <Section id="add-txt-filter" icon={Filter} title="Kategoria">
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    <ChoiceButton active={filter === ""} onClick={() => setFilter("")}>
                      <span className="truncate">Wszystkie</span>
                    </ChoiceButton>
                    {OFFER_SECTION_CATEGORIES.map((k) => (
                      <ChoiceButton
                        key={k}
                        active={filter === k}
                        onClick={() => setFilter(filter === k ? "" : k)}
                      >
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            filter === k ? "bg-primary-foreground" : OFFER_CATEGORY_UI[k].bar
                          )}
                          aria-hidden
                        />
                        <span className="truncate">{OFFER_CATEGORY_META[k].label}</span>
                      </ChoiceButton>
                    ))}
                  </div>
                </Section>

                <Section
                  id="add-txt-list"
                  icon={AlignLeft}
                  title="Opisy"
                  summary={selected.length ? `wybrano ${selected.length}` : undefined}
                >
                  {visible.length === 0 ? (
                    <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                      W tej kategorii nie ma jeszcze wzorców. Zdejmij filtr albo
                      dołóż własny opis i napisz go na miejscu.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {visible.map((t) => {
                        const meta = OFFER_CATEGORY_META[t.category];
                        const checked = selected.includes(t.id);
                        return (
                          <button
                            key={t.id}
                            type="button"
                            aria-pressed={checked}
                            onClick={() => toggle(t.id)}
                            className={cn(
                              "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                              checked
                                ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                                : "hover:bg-muted/60"
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                                checked
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "bg-background"
                              )}
                              aria-hidden
                            >
                              {checked && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{t.name}</span>
                                <span className={pillClass(meta.tone, { compact: true })}>
                                  {meta.label}
                                </span>
                                {t.isDefault && (
                                  <span className={pillClass("emerald", { compact: true })}>
                                    <Pin className="h-2.5 w-2.5" />
                                    domyślny
                                  </span>
                                )}
                              </span>
                              {t.title && (
                                <span className="mt-0.5 block text-xs font-medium text-foreground/80">
                                  {t.title}
                                </span>
                              )}
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {excerpt(t.body) || "— pusta treść —"}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Section>

                {preview && (
                  <Section id="add-txt-preview" icon={Eye} title={`Podgląd — ${preview.name}`}>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      {preview.title && (
                        <h3 className={MD_TITLE_CLASS}>{preview.title}</h3>
                      )}
                      <MdPreview body={preview.body} />
                    </div>
                  </Section>
                )}
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-5 py-3">
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Anuluj
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || selected.length === 0}
              onClick={() => void submit()}
            >
              <Check className="mr-1 h-4 w-4" />
              {busy
                ? "Dodawanie…"
                : selected.length > 1
                  ? `Dodaj ${selected.length} ${textsPlural(selected.length)}`
                  : "Dodaj opis"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
