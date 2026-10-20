import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Link2, Loader2, Share2, UserRound, Wrench } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tip } from "@/components/ui/tooltip";
import {
  eventSharesApi,
  getTechnicians,
  type EventShareCreateInput,
  type EventShareExpiresIn,
  type EventShareRow,
  type Technician,
} from "@/lib/api";
import { fmtRelative, fmtTimestamp } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { Switch } from "@/technik/ui/switch";

/**
 * UDOSTĘPNIJ WYDARZENIE — link do jednego zlecenia bez logowania
 * (kontrakt: docs/UDOSTEPNIANIE-WYDARZEN.md, etap 2 + korekta).
 *
 * Przełącznik „Może pracować” (domyślnie włączony) daje odbiorcy Rozpocznij/
 * Zakończ i własne notatki ze zdjęciami; wyłączony = sam podgląd. Ten sam
 * przełącznik stoi przy każdym aktywnym linku na liście — uprawnienie zmienia
 * się po fakcie, bez nowego linku (optymistycznie, z cofnięciem przy błędzie).
 *
 * Odbiorca jest zawsze nazwany: technik z kartoteki albo gość z wpisanym
 * imieniem — lista linków ma mówić, KTO dostał dostęp, a nie „ktoś”.
 * Pełny URL pokazujemy raz, zaraz po utworzeniu: w bazie jest tylko hash
 * tokenu, więc później nie da się go odtworzyć (wtedy — nowy link).
 */

const EXPIRY_OPTIONS: { value: EventShareExpiresIn; label: string; hint: string }[] = [
  { value: "event+7d", label: "7 dni po wydarzeniu", hint: "Do tygodnia po zakończeniu wydarzenia" },
  { value: "24h", label: "24 godziny", hint: "Dobę od teraz" },
  { value: "30d", label: "30 dni", hint: "Miesiąc od teraz" },
];

const STATUS_META: Record<EventShareRow["status"], { label: string; cls: string }> = {
  active: { label: "aktywny", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  expired: { label: "wygasł", cls: "bg-muted text-muted-foreground" },
  revoked: { label: "unieważniony", cls: "bg-destructive/10 text-destructive" },
};

/**
 * Czy „7 dni po wydarzeniu” ma jeszcze sens. Backend odrzuca tę opcję (400), gdy
 * wydarzenie skończyło się ponad tydzień temu — link byłby martwy od urodzenia —
 * więc nie dajemy jej kliknąć. `endAt` to czas lokalny kalendarza; dla całodniowych
 * sama data (koniec wyłącznie, czyli północ po ostatnim dniu).
 */
function eventPlus7dAlive(endAt: string | null | undefined): boolean {
  if (!endAt) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(endAt);
  if (!m) return true;
  const end = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return end.getTime() + 7 * 86_400_000 > Date.now();
}

const techName = (t: Pick<Technician, "firstName" | "lastName">) =>
  `${t.firstName} ${t.lastName}`.trim();

/** URL składany po stronie przeglądarki — backend za proxy mógłby podać zły origin. */
const shareUrlOf = (token: string) => `${window.location.origin}/u/${token}`;

export interface ShareEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: number;
  /** Tytuł do opisu i do `navigator.share`. */
  eventTitle?: string | null;
  /** Technicy przypisani do wydarzenia — lądują na górze listy. */
  assignedIds?: number[];
  /** Koniec wydarzenia (`endAt` z kalendarza) — wyłącza „7 dni po wydarzeniu” dla starych wydarzeń. */
  eventEndAt?: string | null;
}

export function ShareEventDialog({
  open,
  onOpenChange,
  eventId,
  eventTitle,
  assignedIds = [],
  eventEndAt,
}: ShareEventDialogProps) {
  const plus7dAlive = eventPlus7dAlive(eventEndAt);
  const defaultExpiry: EventShareExpiresIn = plus7dAlive ? "event+7d" : "30d";
  const [mode, setMode] = useState<"technician" | "guest">("technician");
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [guestName, setGuestName] = useState("");
  const [expiresIn, setExpiresIn] = useState<EventShareExpiresIn>(defaultExpiry);
  const [canWork, setCanWork] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Świeżo utworzony link — jedyny moment, kiedy znamy pełny URL. */
  const [created, setCreated] = useState<{ url: string; recipient: string; canWork: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const [technicians, setTechnicians] = useState<Technician[] | null>(null);
  const [techError, setTechError] = useState<string | null>(null);

  const [shares, setShares] = useState<EventShareRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const [toRevoke, setToRevoke] = useState<EventShareRow | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  /** Linki, którym właśnie zapisujemy uprawnienie, i ostatni błąd takiego zapisu. */
  const [workBusy, setWorkBusy] = useState<ReadonlySet<number>>(() => new Set());
  const [workError, setWorkError] = useState<{ id: number; message: string } | null>(null);

  const assignedKey = assignedIds.join(",");

  // Reset przy każdym otwarciu — poprzedni URL nie może wisieć w oknie innego wydarzenia.
  useEffect(() => {
    if (!open) return;
    setMode("technician");
    setTechnicianId(null);
    setGuestName("");
    setExpiresIn(defaultExpiry);
    setCanWork(true);
    setWorkError(null);
    setFormError(null);
    setCreated(null);
    setCopied(false);
    setRevokeError(null);
  }, [open, eventId, defaultExpiry]);

  const loadShares = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setShares(await eventSharesApi.list(eventId));
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Nie udało się wczytać linków.");
    } finally {
      setListLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    if (open) void loadShares();
  }, [open, loadShares]);

  useEffect(() => {
    if (!open || technicians) return;
    let cancelled = false;
    getTechnicians(true)
      .then((r) => {
        if (!cancelled) setTechnicians(r.data ?? []);
      })
      .catch((e) => {
        if (!cancelled) setTechError(e instanceof Error ? e.message : "Nie udało się wczytać techników.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, technicians]);

  const { assigned, others } = useMemo(() => {
    const ids = new Set(assignedKey ? assignedKey.split(",").map(Number) : []);
    const sorted = [...(technicians ?? [])].sort((a, b) => techName(a).localeCompare(techName(b), "pl"));
    return {
      assigned: sorted.filter((t) => ids.has(t.id)),
      others: sorted.filter((t) => !ids.has(t.id)),
    };
  }, [technicians, assignedKey]);

  // Domyślny wybór: pierwszy przypisany technik (najczęstszy przypadek — podwykonawca ze zlecenia).
  useEffect(() => {
    if (open && technicianId == null && assigned.length > 0) setTechnicianId(assigned[0].id);
  }, [open, technicianId, assigned]);

  const create = async () => {
    setFormError(null);
    let recipient: string;
    const input: EventShareCreateInput = { expiresIn, canWork };
    if (mode === "technician") {
      const t = technicians?.find((x) => x.id === technicianId);
      if (!t) {
        setFormError("Wybierz technika albo przełącz na „Gość”.");
        return;
      }
      input.technicianId = t.id;
      recipient = techName(t);
    } else {
      const name = guestName.trim();
      if (!name) {
        document.getElementById("share-guest-name")?.focus();
        setFormError("Wpisz imię i nazwisko albo nazwę odbiorcy — tak będzie wiadomo, kto dostał link.");
        return;
      }
      if (name.length > 80) {
        setFormError("Nazwa odbiorcy może mieć najwyżej 80 znaków.");
        return;
      }
      input.recipientName = name;
      recipient = name;
    }
    setCreating(true);
    try {
      const res = await eventSharesApi.create(eventId, input);
      setCreated({
        url: shareUrlOf(res.token),
        recipient: res.share?.recipientName ?? recipient,
        canWork: res.share?.canWork ?? canWork,
      });
      setCopied(false);
      setGuestName("");
      void loadShares();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Nie udało się utworzyć linku.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Brak uprawnień do schowka (http, stara przeglądarka) — zaznaczamy pole do ręcznego skopiowania.
      const el = document.getElementById("share-url-field") as HTMLInputElement | null;
      el?.select();
    }
  };

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const nativeShare = async () => {
    if (!created) return;
    try {
      await navigator.share({
        title: eventTitle ? `Zlecenie: ${eventTitle}` : "Zlecenie",
        text: `${created.canWork ? "Zlecenie do pracy" : "Podgląd zlecenia"} dla: ${created.recipient}`,
        url: created.url,
      });
    } catch {
      /* anulowane przez użytkownika — nic do zrobienia */
    }
  };

  /** Zmiana uprawnień istniejącego linku — od razu na liście, cofana przy błędzie. */
  const toggleWork = async (share: EventShareRow, next: boolean) => {
    if (workBusy.has(share.id)) return;
    setWorkError(null);
    setWorkBusy((prev) => new Set(prev).add(share.id));
    setShares((list) => list?.map((x) => (x.id === share.id ? { ...x, canWork: next } : x)) ?? list);
    try {
      const row = await eventSharesApi.setCanWork(eventId, share.id, next);
      if (row && typeof row.id === "number") {
        setShares((list) => list?.map((x) => (x.id === row.id ? row : x)) ?? list);
      }
    } catch (e) {
      setShares((list) =>
        list?.map((x) => (x.id === share.id ? { ...x, canWork: share.canWork } : x)) ?? list,
      );
      setWorkError({
        id: share.id,
        message: e instanceof Error ? e.message : "Nie udało się zmienić uprawnień linku.",
      });
      // 409 = link w międzyczasie wygasł albo ktoś go unieważnił — odśwież statusy.
      if ((e as { status?: number }).status === 409) void loadShares();
    } finally {
      setWorkBusy((prev) => {
        const n = new Set(prev);
        n.delete(share.id);
        return n;
      });
    }
  };

  const confirmRevoke = async () => {
    if (!toRevoke) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await eventSharesApi.revoke(eventId, toRevoke.id);
      setToRevoke(null);
      await loadShares();
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : "Nie udało się unieważnić linku.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[100dvh] flex-col gap-0 overflow-hidden p-0 sm:max-h-[90vh] sm:max-w-lg"
          data-testid="share-event-dialog"
        >
          <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4" aria-hidden /> Udostępnij
            </DialogTitle>
            <DialogDescription>
              Link do zlecenia bez logowania. Odbiorca nie widzi notatek biura, protokołu ani kwot.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
            {/* --- Odbiorca --- */}
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Komu</legend>
              <div role="radiogroup" aria-label="Rodzaj odbiorcy" className="grid grid-cols-2 gap-2">
                <ChoiceButton
                  active={mode === "technician"}
                  onClick={() => setMode("technician")}
                  testId="share-mode-technician"
                >
                  <Wrench className="h-4 w-4" aria-hidden /> Technik
                </ChoiceButton>
                <ChoiceButton active={mode === "guest"} onClick={() => setMode("guest")} testId="share-mode-guest">
                  <UserRound className="h-4 w-4" aria-hidden /> Gość
                </ChoiceButton>
              </div>

              {mode === "technician" ? (
                <div className="space-y-1">
                  <Label htmlFor="share-technician" className="sr-only">
                    Technik
                  </Label>
                  {techError ? (
                    <p className="text-sm text-destructive">{techError}</p>
                  ) : (
                    <select
                      id="share-technician"
                      data-testid="share-technician"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                      disabled={!technicians}
                      value={technicianId ?? ""}
                      onChange={(e) => setTechnicianId(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">{technicians ? "— wybierz technika —" : "Wczytuję techników…"}</option>
                      {assigned.length > 0 && (
                        <optgroup label="Przypisani do wydarzenia">
                          {assigned.map((t) => (
                            <option key={t.id} value={t.id}>
                              {techName(t)}
                              {t.company ? ` (${t.company})` : ""}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {others.length > 0 && (
                        <optgroup label={assigned.length > 0 ? "Pozostali" : "Technicy"}>
                          {others.map((t) => (
                            <option key={t.id} value={t.id}>
                              {techName(t)}
                              {t.company ? ` (${t.company})` : ""}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="share-guest-name">
                    Imię i nazwisko lub nazwa <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="share-guest-name"
                    data-testid="share-guest-name"
                    value={guestName}
                    maxLength={80}
                    required
                    aria-required="true"
                    aria-invalid={formError != null && !guestName.trim() ? true : undefined}
                    aria-describedby={formError ? "share-form-error" : undefined}
                    autoComplete="off"
                    placeholder="np. Jan Kowalski, Firma XYZ"
                    onChange={(e) => setGuestName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void create();
                      }
                    }}
                  />
                </div>
              )}
            </fieldset>

            {/* --- Ważność --- */}
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Ważny</legend>
              <div role="radiogroup" aria-label="Ważność linku" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {EXPIRY_OPTIONS.map((o) => (
                  <ChoiceButton
                    key={o.value}
                    active={expiresIn === o.value}
                    onClick={() => setExpiresIn(o.value)}
                    testId={`share-expiry-${o.value}`}
                    disabled={o.value === "event+7d" && !plus7dAlive}
                    tipText={
                      o.value === "event+7d" && !plus7dAlive
                        ? "Wydarzenie skończyło się ponad tydzień temu — link wygasłby od razu"
                        : o.hint
                    }
                  >
                    {o.label}
                  </ChoiceButton>
                ))}
              </div>
            </fieldset>

            {/* --- Uprawnienia --- */}
            <div className="flex items-center gap-3 rounded-lg border px-3 py-1" data-testid="share-can-work-row">
              <div className="min-w-0 flex-1 py-1.5">
                <p className="text-sm font-medium" id="share-can-work-label">
                  Może pracować
                </p>
                <p className="text-xs leading-snug text-muted-foreground">
                  {canWork
                    ? "Rozpocznij/Zakończ oraz własne notatki i zdjęcia."
                    : "Tylko podgląd — bez akcji i notatek."}
                </p>
              </div>
              <span data-testid="share-can-work">
                <Switch checked={canWork} onCheckedChange={setCanWork} label="Może pracować (notatki, start/koniec)" />
              </span>
            </div>

            {formError && (
              <p
                id="share-form-error"
                role="alert"
                className="flex items-start gap-2 text-sm text-destructive"
                data-testid="share-form-error"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {formError}
              </p>
            )}

            <Button
              type="button"
              className="h-11 w-full"
              onClick={() => void create()}
              disabled={creating}
              data-testid="share-create"
            >
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              {creating ? "Tworzę link…" : "Utwórz link"}
            </Button>

            {/* --- Świeży link --- */}
            {created && (
              <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3" data-testid="share-created">
                <p className="text-sm font-medium">Link dla: {created.recipient}</p>
                <div className="flex gap-2">
                  <Input
                    id="share-url-field"
                    readOnly
                    value={created.url}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="share-url"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label="Kopiuj link"
                    onClick={() => void copy()}
                    {...tip(copied ? "Skopiowano" : "Kopiuj link")}
                    data-testid="share-copy"
                  >
                    {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  {canNativeShare && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label="Wyślij link"
                      onClick={() => void nativeShare()}
                      {...tip("Wyślij przez aplikację telefonu")}
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Skopiuj go teraz — pełny adres widać tylko raz. Gdy zginie, unieważnij link i utwórz nowy.
                </p>
              </div>
            )}

            {/* --- Lista linków --- */}
            <section aria-labelledby="share-list-title" className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <h3 id="share-list-title" className="text-sm font-medium">
                  Linki do tego wydarzenia
                </h3>
                {listLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Wczytuję" />}
              </div>
              {listError ? (
                <div className="flex items-center justify-between gap-2 text-sm text-destructive">
                  <span>{listError}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadShares()}>
                    Ponów
                  </Button>
                </div>
              ) : shares && shares.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nikt jeszcze nie dostał linku.</p>
              ) : (
                <ul className="space-y-2" data-testid="share-list">
                  {(shares ?? []).map((s) => (
                    <ShareItem
                      key={s.id}
                      share={s}
                      onRevoke={() => setToRevoke(s)}
                      onToggleWork={(next) => void toggleWork(s, next)}
                      workBusy={workBusy.has(s.id)}
                      workError={workError?.id === s.id ? workError.message : null}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={toRevoke !== null} onOpenChange={(o) => !o && !revoking && setToRevoke(null)}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Unieważnić link?</AlertDialogTitle>
            <AlertDialogDescription>
              {toRevoke?.recipientName} straci dostęp do podglądu od razu. Tego nie da się cofnąć — w razie
              potrzeby utworzysz nowy link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && <p className="text-sm text-destructive">{revokeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revoking}
              onClick={(e) => {
                e.preventDefault();
                void confirmRevoke();
              }}
              data-testid="share-revoke-confirm"
            >
              {revoking ? "Unieważniam…" : "Unieważnij"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
  testId,
  tipText,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
  tipText?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      data-testid={testId}
      {...(tipText ? tip(tipText) : {})}
      className={cn(
        "flex min-h-10 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled
          ? "cursor-not-allowed border-dashed border-input bg-background text-muted-foreground opacity-60"
          : active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-input bg-background hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}

function ShareItem({
  share: s,
  onRevoke,
  onToggleWork,
  workBusy,
  workError,
}: {
  share: EventShareRow;
  onRevoke: () => void;
  onToggleWork: (next: boolean) => void;
  workBusy: boolean;
  workError: string | null;
}) {
  const meta = STATUS_META[s.status] ?? STATUS_META.expired;
  const works = s.canWork === true;
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="share-item">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span className="truncate">{s.recipientName}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {s.technicianId != null ? "technik" : "gość"}
            </span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.cls)}>{meta.label}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Utworzył {s.createdByLabel ?? "—"},{" "}
            <time dateTime={s.createdAt} {...tip(fmtTimestamp(s.createdAt))}>
              {fmtRelative(s.createdAt)}
            </time>
            {" · "}
            {s.status === "revoked" ? (
              <>unieważniony {fmtTimestamp(s.revokedAt)}</>
            ) : (
              <>
                {s.status === "expired" ? "wygasł" : "ważny do"} {fmtTimestamp(s.expiresAt)}
              </>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="share-opens">
            {s.openCount === 0
              ? "Jeszcze nie otwarty"
              : `Otwarty ${s.openCount}×, ostatnio ${fmtRelative(s.lastOpenedAt)}`}
          </p>
          {s.status === "active" ? (
            <div className="mt-1 flex items-center gap-2" data-testid="share-item-can-work">
              <Switch
                checked={works}
                onCheckedChange={onToggleWork}
                busy={workBusy}
                label={`Może pracować: ${s.recipientName}`}
              />
              <span className="text-xs text-muted-foreground">
                {works ? "Może pracować (notatki, start/koniec)" : "Tylko podgląd"}
              </span>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">{works ? "Mógł pracować" : "Tylko podgląd"}</p>
          )}
          {workError && (
            <p role="alert" className="mt-1 text-xs text-destructive" data-testid="share-item-can-work-error">
              {workError}
            </p>
          )}
        </div>
        {s.status === "active" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onRevoke}
            data-testid="share-revoke"
          >
            Unieważnij
          </Button>
        )}
      </div>
    </li>
  );
}
