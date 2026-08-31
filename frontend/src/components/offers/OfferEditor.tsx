/**
 * Edytor oferty: nagłówek, sekcje, panel dzierżawy i lepkie podsumowanie.
 *
 * Cała arytmetyka przychodzi z backendu (`totals` w każdej odpowiedzi) — front
 * jej nie powtarza. Dzięki temu kwota na ekranie i kwota na wydruku nie mogą się
 * rozjechać, a jedyne miejsce, w którym trzeba poprawić wzór, to offer-calc.ts.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CopyPlus,
  Printer,
  RefreshCw,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ContractorPicker } from "@/components/ContractorPicker";
import {
  offersApi,
  type Company,
  type OfferDetail,
  type OfferKind,
  type OfferLeaseMode,
  type OfferPackage,
  type OfferSectionCategory,
  type Salesperson,
  type Service,
  type WarehouseItem,
} from "@/lib/api";
import { pillClass } from "@/lib/calendar-labels";
import { printOffer } from "@/lib/offerPrint";
import { AddPackageDialog } from "./AddPackageDialog";
import { OfferSectionCard } from "./OfferSectionCard";
import {
  OFFER_CATEGORY_META,
  OFFER_KIND_LABEL,
  OFFER_QUICK_CATEGORIES,
  OFFER_STATUS_META,
  fmtPct,
  fmtPln,
  fmtPlnOrDash,
} from "./offersShared";

interface OfferEditorProps {
  detail: OfferDetail;
  editable: boolean;
  minMarginPct: number;
  /** Domyślny procent roczny dzierżawy z ustawień firmy — podpowiedź przy włączaniu. */
  defaultLeaseRate: number;
  packages: OfferPackage[];
  warehouseItems: WarehouseItem[];
  services: Service[];
  salespeople: Salesperson[];
  companies: Company[];
  stockByItem: Map<number, number>;
  onChange: (next: OfferDetail) => void;
  onBack: () => void;
  onReloadPackages: () => Promise<void>;
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

const LEASE_MODE_LABEL: Record<OfferLeaseMode, string> = {
  none: "Bez dzierżawy",
  y1: "12 miesięcy",
  y2: "24 miesiące",
  custom: "Własny okres",
};

export function OfferEditor({
  detail,
  editable,
  minMarginPct,
  defaultLeaseRate,
  packages,
  warehouseItems,
  services,
  salespeople,
  companies,
  stockByItem,
  onChange,
  onBack,
  onReloadPackages,
}: OfferEditorProps) {
  const { offer, sections, items, totals } = detail;
  // Oferta zamknięta jest tylko do odczytu, nawet gdy użytkownik ma prawo edycji —
  // zmiany robi się przez nową wersję (pilnuje tego też backend, zwracając 409).
  const frozen = offer.status !== "draft";
  const canEdit = editable && !frozen;
  const showCosts = totals.margin !== undefined || items.some((i) => i.unitCost !== undefined);

  /** Stan formularza odtworzony z dokumentu — jedno źródło dla inicjalizacji i cofania. */
  const formFrom = (o: typeof offer) => ({
    date: o.date,
    validUntil: o.validUntil ?? "",
    kind: o.kind,
    clientName: o.clientName,
    clientNip: o.clientNip,
    contractorId: o.contractorId,
    site: o.site,
    address: o.address,
    salespersonId: o.salespersonId,
    companyId: o.companyId,
    discountPct: o.discountPct,
    leaseMode: o.leaseMode,
    leaseMonths: o.leaseMonths,
    leaseAnnualRate: o.leaseAnnualRate,
    leaseIncludeLabour: o.leaseIncludeLabour,
    notes: o.notes ?? "",
  });

  const [form, setForm] = useState({
    date: offer.date,
    validUntil: offer.validUntil ?? "",
    kind: offer.kind,
    clientName: offer.clientName,
    clientNip: offer.clientNip,
    contractorId: offer.contractorId,
    site: offer.site,
    address: offer.address,
    salespersonId: offer.salespersonId,
    companyId: offer.companyId,
    discountPct: offer.discountPct,
    leaseMode: offer.leaseMode,
    leaseMonths: offer.leaseMonths,
    leaseAnnualRate: offer.leaseAnnualRate,
    leaseIncludeLabour: offer.leaseIncludeLabour,
    notes: offer.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [addCategory, setAddCategory] = useState<OfferSectionCategory | null>(null);

  /*
   * SYNCHRONIZACJA FORMULARZA Z SERWEREM — tylko gdy zmienia się DOKUMENT.
   *
   * Wcześniej efekt wisiał na `[offer]`, a `onChange(res.data)` woła KAŻDA
   * mutacja (ilość pozycji, cena, dodanie sekcji, przeliczenie cen). Skutek:
   * jeśli w tle kończył się dowolny zapis, pole, w którym użytkownik akurat
   * pisał, wracało do wartości serwerowej — tekst znikał bez śladu i bez
   * ostrzeżenia, z kursorem dalej w środku.
   *
   * Teraz przepisujemy formularz wyłącznie przy PRZEJŚCIU NA INNY DOKUMENT
   * (inne id albo inna wersja) oraz gdy zmieni się status (wysłanie/akceptacja
   * blokują edycję). Zmiany nagłówka i tak wracają z serwera w `res.data`,
   * a lokalny stan jest ich źródłem, więc nie ma czego nadpisywać.
   */
  const documentKey = `${offer.id}:${offer.version}:${offer.status}`;
  useEffect(() => {
    setForm(formFrom(offer));
    // Celowo TYLKO `documentKey` — patrz komentarz wyżej.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey]);

  const hasEquipment = useMemo(
    () => items.some((i) => i.kind === "material" && i.billing === "one_time"),
    [items]
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Operacja nie powiodła się");
    } finally {
      setBusy(false);
    }
  };

  /*
   * ZAPIS CZĄSTKOWY — wysyłamy WYŁĄCZNIE zmienione pola.
   *
   * Wcześniej każdy zapis szedł pełnym snapshotem nagłówka czytanym z domknięcia,
   * więc dwa szybkie zapisy pod rząd kończyły się zgubieniem pierwszego: żądanie
   * wysłane wcześniej, ale doręczone później, przywracało stary stan pozostałych
   * pól. Patch jest odporny na kolejność — „zmień zakres" i „zmień termin" nie
   * mają o co się bić.
   *
   * Gdy zapis się nie uda (409 na zamrożonej ofercie, błąd sieci), wracamy do
   * wartości serwerowej: to, co widać na ekranie, ma być tym, co jest w bazie.
   */
  const save = (patch: Partial<typeof form>) =>
    run(async () => {
      setForm((prev) => ({ ...prev, ...patch }));
      try {
        const payload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          payload[k] = k === "validUntil" ? (v as string) || null : v;
        }
        const res = await offersApi.update(offer.id, payload);
        if (res.data) onChange(res.data);
      } catch (err) {
        setForm(formFrom(offer));
        throw err;
      }
    });

  const statusMeta = OFFER_STATUS_META[offer.status];
  const company = companies.find((c) => c.id === offer.companyId) ?? null;
  const leaseActive = offer.leaseMode !== "none" && totals.leaseMonthly > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Lista ofert
        </Button>
        <h2 className="text-xl font-semibold">{offer.number}</h2>
        <span className={pillClass(statusMeta.tone)}>{statusMeta.label}</span>
        {offer.version > 1 && (
          <span className={pillClass("neutral")}>wersja {offer.version}</span>
        )}
        {offer.orderId && (
          <a href={`/orders/${offer.orderId}`} className={pillClass("emerald")}>
            zlecenie →
          </a>
        )}
        {offer.warehouseDocId && (
          <a href="/technical/magazyn" className={pillClass("sky")}>
            szkic WZ →
          </a>
        )}
      </div>

      {frozen && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Oferta jest zamknięta — to, co dostał klient, musi dać się odtworzyć.
            Żeby coś zmienić, utwórz nową wersję.
          </span>
        </div>
      )}

      {/* --- Nagłówek --- */}
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <ContractorPicker
              value={form.clientName}
              disabled={!canEdit}
              onChange={(v) => setForm((p) => ({ ...p, clientName: v }))}
              onSelect={(c) =>
                save({
                  clientName: c.name,
                  clientNip: c.nip ?? "",
                  contractorId: c.id,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-site">Obiekt</Label>
            <Input
              id="of-site"
              value={form.site}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, site: e.target.value }))}
              onBlur={() => form.site !== offer.site && save({ site: form.site })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-address">Adres</Label>
            <Input
              id="of-address"
              value={form.address}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
              onBlur={() => form.address !== offer.address && save({ address: form.address })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-date">Data oferty</Label>
            <Input
              id="of-date"
              type="date"
              value={form.date}
              disabled={!canEdit}
              onChange={(e) => save({ date: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-valid">Ważna do</Label>
            <Input
              id="of-valid"
              type="date"
              value={form.validUntil}
              disabled={!canEdit}
              onChange={(e) => save({ validUntil: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-kind">Zakres</Label>
            <select
              id="of-kind"
              className={selectClass}
              value={form.kind}
              disabled={!canEdit}
              onChange={(e) => save({ kind: e.target.value as OfferKind })}
            >
              {(Object.keys(OFFER_KIND_LABEL) as OfferKind[]).map((k) => (
                <option key={k} value={k}>
                  {OFFER_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-sales">Handlowiec</Label>
            <select
              id="of-sales"
              className={selectClass}
              value={form.salespersonId ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                save({ salespersonId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">— brak —</option>
              {salespeople.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.firstName} {s.lastName}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-company">Spółka wystawiająca</Label>
            <select
              id="of-company"
              className={selectClass}
              value={form.companyId ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                save({ companyId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">— brak —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Z niej wydruk bierze NIP, KRS i adres do stopki.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="of-discount">Rabat na całość (%)</Label>
            <Input
              id="of-discount"
              type="number"
              min="0"
              max="100"
              step="0.1"
              className="tabular-nums"
              value={form.discountPct}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, discountPct: Number(e.target.value) }))}
              onBlur={() => form.discountPct !== offer.discountPct && save({ discountPct: form.discountPct })}
            />
          </div>
        </CardContent>
      </Card>

      {/* --- Pasek dodawania sekcji --- */}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {OFFER_QUICK_CATEGORIES.map((cat) => (
            <Button key={cat} variant="outline" onClick={() => setAddCategory(cat)}>
              + {OFFER_CATEGORY_META[cat].label}
            </Button>
          ))}
          <Button variant="outline" onClick={() => setAddCategory("inne")}>
            + Pusta sekcja
          </Button>
        </div>
      )}

      {/* --- Sekcje --- */}
      {sections.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Oferta jest pusta. Zacznij od przycisku „+ CCTV" albo „+ SSWiN” —
            pakiet doda od razu sprzęt i robociznę.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sections.map((section) => (
            <OfferSectionCard
              key={section.id}
              section={section}
              items={items.filter((i) => i.sectionId === section.id)}
              editable={canEdit}
              showCosts={showCosts}
              minMarginPct={minMarginPct}
              warehouseItems={warehouseItems}
              services={services}
              stockByItem={stockByItem}
              onUpdateSection={async (patch) => {
                const res = await offersApi.updateSection(offer.id, section.id, patch);
                if (res.data) onChange(res.data);
              }}
              onRemoveSection={async () => {
                const res = await offersApi.removeSection(offer.id, section.id);
                if (res.data) onChange(res.data);
              }}
              onSaveAsPackage={async () => {
                const name = window.prompt("Nazwa pakietu:", section.title);
                if (!name) return;
                await offersApi.saveSectionAsPackage(offer.id, section.id, { name });
                await onReloadPackages();
                window.alert(`Zapisano pakiet „${name}”.`);
              }}
              onAddItem={async (picked) => {
                const res = await offersApi.addItem(offer.id, {
                  sectionId: section.id,
                  source: picked.source,
                  warehouseItemId: picked.warehouseItemId ?? null,
                  serviceId: picked.serviceId ?? null,
                  // Rodzaj i cykl wynikają ze źródła: towar to sprzęt płatny
                  // jednorazowo, usługa „abonament” to pozycja miesięczna.
                  kind: picked.source === "warehouse" ? "material" : "labour",
                  billing: "one_time",
                  qty: 1,
                });
                if (res.data) onChange(res.data);
              }}
              onUpdateItem={async (itemId, patch) => {
                const res = await offersApi.updateItem(offer.id, itemId, patch);
                if (res.data) onChange(res.data);
              }}
              onRemoveItem={async (itemId) => {
                const res = await offersApi.removeItem(offer.id, itemId);
                if (res.data) onChange(res.data);
              }}
            />
          ))}
        </div>
      )}

      {/* --- Dzierżawa --- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">Dzierżawa sprzętu</h3>
            {!hasEquipment && (
              <span className="text-xs text-muted-foreground">
                — dostępna, gdy w ofercie jest sprzęt
              </span>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="of-lease-mode">Okres</Label>
              <select
                id="of-lease-mode"
                className={selectClass}
                value={form.leaseMode}
                disabled={!canEdit || !hasEquipment}
onChange={(e) => {
                  const mode = e.target.value as OfferLeaseMode;
                  // Włączenie dzierżawy bez stawki nic by nie policzyło, więc
                  // od razu podpowiadamy domyślny procent z ustawień firmy.
                  const patch: Partial<typeof form> = { leaseMode: mode };
                  if (mode !== "none" && !(form.leaseAnnualRate && form.leaseAnnualRate > 0)) {
                    patch.leaseAnnualRate = defaultLeaseRate;
                  }
                  save(patch);
                }}
              >
                {(Object.keys(LEASE_MODE_LABEL) as OfferLeaseMode[]).map((m) => (
                  <option key={m} value={m}>
                    {LEASE_MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>

            {form.leaseMode === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="of-lease-months">Liczba miesięcy</Label>
                <Input
                  id="of-lease-months"
                  type="number"
                  min="1"
                  className="tabular-nums"
                  value={form.leaseMonths ?? ""}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      leaseMonths: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  onBlur={() => form.leaseMonths !== offer.leaseMonths && save({ leaseMonths: form.leaseMonths })}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="of-lease-rate">Procent roczny (%)</Label>
              <Input
                id="of-lease-rate"
                type="number"
                min="0"
                step="0.1"
                className="tabular-nums"
                value={form.leaseAnnualRate ?? ""}
                disabled={!canEdit || form.leaseMode === "none"}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    leaseAnnualRate: e.target.value ? Number(e.target.value) : null,
                  }))
                }
                onBlur={() => form.leaseAnnualRate !== offer.leaseAnnualRate && save({ leaseAnnualRate: form.leaseAnnualRate })}
              />
            </div>

            <div className="space-y-2">
              <Label>Podstawa</Label>
              <label className="flex h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={form.leaseIncludeLabour}
                  disabled={!canEdit || form.leaseMode === "none"}
                  onChange={(e) => save({ leaseIncludeLabour: e.target.checked })}
                />
                Z robocizną
              </label>
            </div>
          </div>

          {leaseActive && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-sm">
              Podstawa <strong className="tabular-nums">{fmtPln(totals.leaseBase)}</strong> ×{" "}
              {fmtPct(offer.leaseAnnualRate)} rocznie ÷ 12 ={" "}
              <strong className="tabular-nums">{fmtPln(totals.leaseMonthly)}</strong> / mies.
              {offer.leaseMonthsEffective ? ` przez ${offer.leaseMonthsEffective} mies.` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      {/* --- Uwagi --- */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label htmlFor="of-notes">Uwagi na ofercie</Label>
          <Textarea
            id="of-notes"
            rows={3}
            value={form.notes}
            disabled={!canEdit}
            onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
            onBlur={() => form.notes !== (offer.notes ?? "") && save({ notes: form.notes })}
          />
        </CardContent>
      </Card>

      {/* --- Lepkie podsumowanie ---
          `sticky`, nie `fixed`: pasek ma trzymać się KOLUMNY TREŚCI. Pozycja
          `fixed inset-x-0` rozciągałaby go na całe okno i wsuwała lewą część
          pod sidebar, którego szerokość zależy jeszcze od zwinięcia. */}
      <div className="sticky bottom-0 z-10 -mx-3 border-t bg-background/95 backdrop-blur lg:-mx-4">
        {/*
          Podsumowanie rozdzielone na DWIE STRONY UMOWY, bo to dwie różne
          rozmowy: po lewej wszystko, co widzi i płaci klient, po prawej to,
          co firma wykłada i na tym zarabia. Wcześniej kwoty klienta i marża
          leżały w jednym rzędzie i przy szybkim spojrzeniu łatwo było wziąć
          koszt własny za pozycję oferty.
        */}
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 px-3 py-3 lg:px-4">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Zleceniodawca — płaci
            </div>
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
              <Sum label="Do zapłaty jednorazowo" value={fmtPln(totals.oneTimePayable)} strong />
              {leaseActive && (
                <>
                  <Sum
                    label="Sprzęt w dzierżawie"
                    value={fmtPln(totals.equipmentValue)}
                    hint="informacyjnie — poza kwotą"
                  />
                  {/* Kwoty PO rabacie — te same, które idą na wydruk, żeby wiersze
                      sumowały się do „Razem miesięcznie". */}
                  <Sum label="Dzierżawa / mies." value={fmtPln(totals.leaseMonthlyNet)} />
                </>
              )}
              {totals.monthlyPrice > 0 && (
                <Sum label="Abonament / mies." value={fmtPln(totals.monthlyPriceNet)} />
              )}
              <Sum label="Razem miesięcznie" value={fmtPln(totals.monthlyTotal)} strong />
              {totals.optionsOneTime > 0 && (
                <Sum
                  label="Opcje jednorazowo"
                  value={fmtPln(totals.optionsOneTime)}
                  hint="poza kwotą"
                />
              )}
              {totals.optionsMonthly > 0 && (
                <Sum
                  label="Opcje / mies."
                  value={fmtPln(totals.optionsMonthly)}
                  hint="poza kwotą"
                />
              )}
            </div>
          </div>

          {showCosts && (
            /* Tło zamiast pionowej kreski: pasek zawija się na wąskich ekranach,
               a wtedy `border-l` czytałoby się jak przypadkowe wcięcie. Blok
               z własnym tłem wygląda tak samo celowo w obu układach — i od razu
               mówi „to nie idzie do klienta". */
            <div className="rounded-md bg-muted/50 px-3 py-1.5">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Zleceniobiorca — wykłada i zarabia
              </div>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                <Sum
                  label="Koszt wdrożenia"
                  value={fmtPlnOrDash(totals.oneTimeCost)}
                  hint={
                    totals.oneTimeCost === null || totals.oneTimeCost === undefined
                      ? "brak ceny zakupu na części pozycji"
                      : `sprzęt ${fmtPlnOrDash(totals.oneTimeCostMaterial)} · robocizna ${fmtPlnOrDash(
                          totals.oneTimeCostLabour
                        )}`
                  }
                />
                {totals.monthlyCost !== null && totals.monthlyCost !== undefined && totals.monthlyCost > 0 && (
                  <Sum
                    label="Koszt / mies."
                    value={fmtPln(totals.monthlyCost)}
                    hint="abonamenty, łącza, interwencje"
                  />
                )}
                {totals.margin !== undefined && (
                  <Sum
                    label={`Marża (${totals.marginHorizonMonths} mies.)`}
                    value={totals.margin ? fmtPct(totals.margin.marginPct) : "—"}
                    strong
                    hint={
                      totals.margin
                        ? `zysk ${fmtPln(totals.margin.amount)} przez ${totals.marginHorizonMonths} mies.`
                        : items.length === 0
                          ? "oferta nie ma jeszcze pozycji"
                          : "brak kosztu na części pozycji"
                    }
                    danger={!!totals.belowMinMargin}
                  />
                )}
              </div>
            </div>
          )}

          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => printOffer(detail, { withCosts: showCosts, company })}
            >
              <Printer className="mr-1 h-4 w-4" /> Drukuj
            </Button>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const res = await offersApi.reprice(offer.id);
                    if (res.data) onChange(res.data);
                    window.alert(res.message ?? "Ceny przeliczone");
                  })
                }
              >
                <RefreshCw className="mr-1 h-4 w-4" /> Przelicz ceny
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                disabled={busy || items.length === 0}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm("Oznaczyć ofertę jako wysłaną? Zostanie zamknięta do edycji."))
                      return;
                    const res = await offersApi.send(offer.id);
                    if (res.data) onChange(res.data);
                  })
                }
              >
                <Send className="mr-1 h-4 w-4" /> Wyślij
              </Button>
            )}
            {editable && frozen && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const res = await offersApi.newVersion(offer.id);
                    if (res.data) {
                      const fresh = await offersApi.get(res.data.id);
                      if (fresh.data) onChange(fresh.data);
                    }
                  })
                }
              >
                <CopyPlus className="mr-1 h-4 w-4" /> Nowa wersja
              </Button>
            )}
            {editable && offer.status === "sent" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (!window.confirm("Oznaczyć ofertę jako odrzuconą przez klienta?")) return;
                      const res = await offersApi.reject(offer.id);
                      if (res.data) onChange(res.data);
                    })
                  }
                >
                  <Ban className="mr-1 h-4 w-4" /> Odrzucona
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (
                        !window.confirm(
                          "Zaakceptować ofertę? Powstanie zlecenie i szkic WZ na sprzęt."
                        )
                      )
                        return;
                      const res = await offersApi.accept(offer.id);
                      if (res.data) onChange(res.data);
                      window.alert(res.message ?? "Oferta zaakceptowana");
                    })
                  }
                >
                  <Check className="mr-1 h-4 w-4" /> Akceptuj
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {addCategory && (
        <AddPackageDialog
          open
          category={addCategory}
          packages={packages}
          onClose={() => setAddCategory(null)}
          onAdd={async (packageId, params) => {
            const res = await offersApi.addSection(offer.id, {
              packageId,
              params,
              category: addCategory,
            });
            if (res.data) onChange(res.data);
          }}
        />
      )}
    </div>
  );
}

function Sum({
  label,
  value,
  hint,
  strong = false,
  danger = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="min-w-[9rem]">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`tabular-nums ${strong ? "text-lg font-semibold" : "text-sm font-medium"} ${
          danger ? "text-red-600" : ""
        }`}
      >
        {danger && <AlertTriangle className="mr-1 inline h-4 w-4" />}
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
