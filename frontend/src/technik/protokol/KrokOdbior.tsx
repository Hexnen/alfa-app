import { AlertTriangle, CheckCircle2, ClipboardCheck, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REALIZATION_WORK_TYPE_META } from "@/lib/calendar-labels";
import { ClearableInput } from "../ui/clearable-input";
import { Field, Panel, ReadRow } from "../ui/panel";
import { scrollFieldIntoView } from "../lib/keyboard";
import { clockOf, formatDatePl } from "../lib/dates";
import { activityLines } from "../lib/activities";
import { cleanItems, countLabel, gapsOf, pl, shortContactName } from "../lib/protocol";
import type { StepProps } from "./types";

/**
 * KROK 4 — ODBIÓR.
 *
 * Najpierw CAŁY protokół w jednej karcie tylko do odczytu: technik czyta to
 * klientowi zanim poda mu rysik, więc podsumowanie musi być kompletne i nie
 * może wymagać skakania po krokach. Pod nim lista braków — informacyjna,
 * bo u klienta bywa, że nie ma czego wpisać, a zablokowany podpis oznaczałby
 * powrót na obiekt.
 *
 * Po podpisie krok zamienia się w ekran zamknięcia: kiedy, kto, jak wyglądał
 * podpis. Nie ma „cofnij podpis” — od tego jest biuro.
 */
export function KrokOdbior({
  protocol,
  job,
  form,
  set,
  readOnly,
  signed,
  onSign,
  onGap,
}: StepProps & {
  signed: boolean;
  onSign: () => void;
  /** Skok do kroku, w którym siedzi brak. */
  onGap: (step: ReturnType<typeof gapsOf>[number]["step"]) => void;
}) {
  const gaps = gapsOf(form);
  const items = cleanItems(form.items);
  const lines = activityLines(form.activities);
  const workType = REALIZATION_WORK_TYPE_META[form.workType];

  /** Pełna sklejka z kartoteki, gdy w polu stoi już samo nazwisko z niej wycięte. */
  const contactHint =
    protocol.contact && protocol.contact.trim() !== form.contact.trim()
      ? protocol.contact.trim()
      : null;

  return (
    <div className="space-y-3" data-testid="protokol-panel-odbior">
      {/* --- PO PODPISIE: EKRAN ZAMKNIĘCIA --------------------------- */}
      {signed && (
        <Panel
          className="border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
          data-testid="protokol-podpisany"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2
              className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="font-semibold leading-snug">
                Podpisano {formatDatePl(protocol.signedAt).slice(0, 5)}
                {clockOf(protocol.signedAt) ? ` o ${clockOf(protocol.signedAt)}` : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                Odebrał: {protocol.signerName || form.contact || "—"}
              </p>
            </div>
          </div>
          {protocol.signaturePng && (
            <div className="rounded-lg border bg-white p-2">
              <img
                src={protocol.signaturePng}
                alt={`Podpis: ${protocol.signerName ?? "klient"}`}
                className="mx-auto max-h-28"
              />
            </div>
          )}
          <p className="text-xs leading-snug text-muted-foreground">
            Protokół jest zamknięty — poprawki robi już biuro.
          </p>
        </Panel>
      )}

      {/* --- PODSUMOWANIE WSZYSTKIEGO -------------------------------- */}
      <Panel icon={ClipboardCheck} title="Podsumowanie protokołu">
        <dl className="space-y-1">
          <ReadRow label="Klient" value={protocol.clientName} />
          <ReadRow
            label="Adres montażu"
            value={protocol.installationAddress || protocol.clientCity || job?.address}
          />
          <ReadRow label="Rodzaj prac" value={workType.label} />
          <ReadRow label="Data wykonania" value={formatDatePl(form.workDate)} />
          <ReadRow label="Godziny" value={form.actualHours > 0 ? `${pl(form.actualHours)} h` : ""} />
          <ReadRow label="Kilometry" value={form.actualKm > 0 ? `${pl(form.actualKm)} km` : ""} />
          <ReadRow
            label="Czynności"
            value={lines.length > 0 ? lines.map((l) => `• ${l}`).join("\n") : ""}
          />
          <ReadRow
            label="Urządzenia"
            value={
              items.length > 0
                ? items
                    .map(
                      (i) =>
                        `• ${i.name || "—"}${i.serial ? ` (nr ${i.serial})` : ""} — ${i.qty || "1"} ${i.unit || ""}`.trim(),
                    )
                    .join("\n")
                : ""
            }
          />
        </dl>
      </Panel>

      {/* --- BRAKI (informacja, nie blokada) ------------------------- */}
      {!signed && gaps.length > 0 && (
        <Panel
          title={`Braki (${gaps.length})`}
          icon={AlertTriangle}
          className="border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10"
          data-testid="protokol-braki"
        >
          <ul className="space-y-1.5">
            {gaps.map((g) => (
              <li key={g.label}>
                <button
                  type="button"
                  onClick={() => onGap(g.step)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left text-sm active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">{g.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">uzupełnij →</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-snug text-muted-foreground">
            Braki nie blokują podpisu — jeśli nie ma czego wpisać, podpisz protokół tak, jak jest.
          </p>
        </Panel>
      )}

      {/* --- OSOBA ODBIERAJĄCA + PODPIS ------------------------------ */}
      <Panel icon={PenLine} title="Odbiór">
        <Field
          label="Osoba odbierająca"
          htmlFor="p-contact"
          hint={
            contactHint ? (
              <span data-testid="contact-hint">Kontakt z kartoteki: {contactHint}</span>
            ) : null
          }
        >
          <ClearableInput
            id="p-contact"
            value={form.contact}
            disabled={readOnly}
            onChange={(v) => set("contact", v)}
            onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
            placeholder="Imię i nazwisko"
            autoComplete="off"
            clearLabel="Wyczyść osobę odbierającą"
            className="h-12 text-base"
          />
          {!readOnly && !form.contact.trim() && contactHint && (
            <Button
              variant="outline"
              className="mt-2 h-11 w-full justify-start text-base"
              onClick={() => set("contact", shortContactName(contactHint))}
            >
              Wstaw z kartoteki: {shortContactName(contactHint)}
            </Button>
          )}
        </Field>

        {!signed && (
          <Button
            size="lg"
            className="h-12 w-full text-base"
            disabled={readOnly}
            data-testid="protokol-podpis-krok"
            onClick={onSign}
          >
            <PenLine className="mr-2 h-5 w-5" />
            Podpis klienta
          </Button>
        )}

        {!signed && (
          <p className="text-xs leading-snug text-muted-foreground">
            {countLabel(lines.length, "czynność", "czynności", "czynności")} ·{" "}
            {countLabel(items.length, "pozycja", "pozycje", "pozycji")} · po podpisie protokołu nie
            da się już zmienić.
          </p>
        )}
      </Panel>
    </div>
  );
}
