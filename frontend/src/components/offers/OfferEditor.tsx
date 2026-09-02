/**
 * Edytor oferty: nagłówek, sekcje, panel dzierżawy i lepkie podsumowanie.
 *
 * Cała arytmetyka przychodzi z backendu (`totals` w każdej odpowiedzi) — front
 * jej nie powtarza. Dzięki temu kwota na ekranie i kwota na wydruku nie mogą się
 * rozjechać, a jedyne miejsce, w którym trzeba poprawić wzór, to offer-calc.ts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Building2,
  Check,
  CopyPlus,
  FileText,
  Printer,
  RefreshCw,
  Send,
  StickyNote,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";
import { ContractorPicker } from "@/components/ContractorPicker";
import {
  offersApi,
  parsePackageParams,
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
import { Section } from "./offersUi";
import {
  OFFER_CATEGORY_META,
  OFFER_CATEGORY_UI,
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
  "flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";

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

  /**
   * Etykiety parametrów pakietu („cameras" → „Liczba kamer") dla paska
   * przeliczania sekcji. Sekcja pamięta same wartości; nazwy stoją w pakiecie.
   */
  const paramLabelsFor = useMemo(() => {
    const byPackage = new Map<number, Record<string, string>>();
    for (const p of packages) {
      const labels: Record<string, string> = {};
      for (const d of parsePackageParams(p.params)) labels[d.key] = d.label || d.key;
      byPackage.set(p.id, labels);
    }
    return (packageId: number | null) =>
      packageId === null ? undefined : byPackage.get(packageId);
  }, [packages]);

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
    contractMonths: o.contractMonths,
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
    contractMonths: offer.contractMonths as number | null,
    leaseMode: offer.leaseMode,
    leaseMonths: offer.leaseMonths,
    leaseAnnualRate: offer.leaseAnnualRate,
    leaseIncludeLabour: offer.leaseIncludeLabour,
    notes: offer.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [addCategory, setAddCategory] = useState<OfferSectionCategory | null>(null);
  /*
   * NAGŁÓWEK ZWINIĘTY DOMYŚLNIE, gdy dane już są. Klient, obiekt i termin
   * ustawia się raz, a potem pracuje się nad pozycjami — trzymanie dziewięciu
   * pól rozwiniętych zjadało pół ekranu przy każdym wejściu w ofertę. Świeży
   * dokument (bez klienta) otwiera się rozwinięty, bo tam trzeba zacząć.
   */
  const [openHead, setOpenHead] = useState({
    client: !offer.clientName.trim(),
    doc: false,
    lease: false,
    // Uwagi zostają rozwinięte, gdy coś w nich stoi — to treść dla klienta,
    // nie ustawienie, i chowanie jej pod chevron kosztowałoby więcej, niż daje.
    notes: !!(offer.notes ?? "").trim(),
  });

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

  /** „2026-08-23" → „23.08.2026"; puste pole zostaje kreską. */
  const fmtDate = (v: string) => (v ? v.split("-").reverse().join(".") : "—");

  /** Co widać, gdy sekcja jest zwinięta — na tyle konkretnie, żeby nie rozwijać jej odruchowo. */
  const clientSummary = [form.clientName || "bez klienta", form.site, form.address]
    .filter(Boolean)
    .join(" · ");
  const docSummary = [
    `${fmtDate(form.date)} → ${fmtDate(form.validUntil)}`,
    OFFER_KIND_LABEL[form.kind],
    salespeople.find((x) => x.id === form.salespersonId)
      ? `${salespeople.find((x) => x.id === form.salespersonId)!.firstName} ${
          salespeople.find((x) => x.id === form.salespersonId)!.lastName
        }`
      : null,
    companies.find((c) => c.id === form.companyId)?.name ?? null,
    form.contractMonths ? `kontrakt ${form.contractMonths} mies.` : null,
    form.discountPct > 0 ? `rabat ${fmtPct(form.discountPct)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  /** Skąd wziął się okres, na którym liczą się pieniądze — jedno zdanie do tooltipów. */
  const horizonHint =
    totals.horizonSource === "contract"
      ? `okres z przewidywanego czasu kontraktu (${totals.marginHorizonMonths} mies.)`
      : totals.horizonSource === "lease"
        ? `okres z długości dzierżawy (${totals.marginHorizonMonths} mies.) — wpisz czas kontraktu, jeśli klient zostaje dłużej`
        : "brak czasu kontraktu i dzierżawy — liczymy domyślne 12 mies.";

  const leaseSummary = !hasEquipment
    ? "dostępna, gdy w ofercie jest sprzęt"
    : offer.leaseMode === "none"
      ? "wyłączona"
      : [
          LEASE_MODE_LABEL[offer.leaseMode],
          offer.leaseAnnualRate ? `${fmtPct(offer.leaseAnnualRate)} rocznie` : null,
          totals.leaseMonthly > 0 ? `${fmtPln(totals.leaseMonthly)} / mies.` : null,
          offer.leaseIncludeLabour ? "z robocizną" : null,
        ]
          .filter(Boolean)
          .join(" · ");

  /*
   * AKCJE DOKUMENTU stoją w górnym pasku, nie w podsumowaniu na dole. Wcześniej
   * „Wyślij" i „Akceptuj" jechały razem z kwotami w lepkim pasku, przez co przy
   * długiej ofercie przycisk kończący sprawę leżał pod pozycjami — a pasek
   * kwot musiał być wysoki, żeby je pomieścić.
   */
  const docActions = (
    <div className="flex flex-wrap items-center gap-2">
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
                  !window.confirm("Zaakceptować ofertę? Powstanie zlecenie i szkic WZ na sprzęt.")
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
  );

  return (
    <div className="space-y-4">
      {/* Pasek dokumentu — lepki, żeby numer, status i akcje były pod ręką
          niezależnie od tego, jak długa jest oferta. */}
      <div className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur lg:-mx-4 lg:px-4">
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
        <div className="ml-auto">{docActions}</div>
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

      {/* --- Nagłówek: dwie sekcje, bo to dwie różne rozmowy — z kim i o czym
              robimy ofertę, oraz jakim dokumentem to obsługujemy --- */}
      <Card>
        <CardContent className="space-y-2 p-3">
        <Section
          id="of-client"
          icon={Building2}
          title="Klient i obiekt"
          summary={clientSummary}
          open={openHead.client}
          onToggle={() => setOpenHead((p) => ({ ...p, client: !p.client }))}
        >
        <AutoCollapse onLeave={() => setOpenHead((p) => ({ ...p, client: false }))}>
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Kontrahent" htmlFor="of-contractor">
            <ContractorPicker
              id="of-contractor"
              label=""
              inputClassName="h-8"
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
          </Field>

          <Field label="Obiekt" htmlFor="of-site">
            <Input
              id="of-site"
              className="h-8"
              value={form.site}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, site: e.target.value }))}
              onBlur={() => form.site !== offer.site && save({ site: form.site })}
            />
          </Field>

          <Field label="Adres" htmlFor="of-address">
            <Input
              id="of-address"
              className="h-8"
              value={form.address}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
              onBlur={() => form.address !== offer.address && save({ address: form.address })}
            />
          </Field>

        </div>
        </AutoCollapse>
        </Section>

        <Section
          id="of-doc"
          icon={FileText}
          title="Dokument"
          summary={docSummary}
          open={openHead.doc}
          onToggle={() => setOpenHead((p) => ({ ...p, doc: !p.doc }))}
        >
        <AutoCollapse onLeave={() => setOpenHead((p) => ({ ...p, doc: false }))}>
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Data oferty" htmlFor="of-date">
            <Input
              id="of-date"
              type="date"
              className="h-8"
              value={form.date}
              disabled={!canEdit}
              onChange={(e) => save({ date: e.target.value })}
            />
          </Field>

          <Field label="Ważna do" htmlFor="of-valid">
            <Input
              id="of-valid"
              type="date"
              className="h-8"
              value={form.validUntil}
              disabled={!canEdit}
              onChange={(e) => save({ validUntil: e.target.value })}
            />
          </Field>

          <Field label="Zakres" htmlFor="of-kind">
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
          </Field>

          <Field label="Handlowiec" htmlFor="of-sales">
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
          </Field>

          <Field
            label="Spółka"
            htmlFor="of-company"
            hint="Z niej wydruk bierze NIP, KRS i adres do stopki"
          >
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
          </Field>

          <Field
            label="Czas kontraktu"
            htmlFor="of-contract-months"
            hint="Ile miesięcy klient ma zostać. Na tym okresie liczą się marża, zysk i prowizja; puste = długość dzierżawy, a bez niej 12 mies."
          >
            <Input
              id="of-contract-months"
              type="number"
              min="1"
              max="120"
              placeholder="mies."
              className="h-8 tabular-nums"
              value={form.contractMonths ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  contractMonths: e.target.value ? Number(e.target.value) : null,
                }))
              }
              onBlur={() =>
                form.contractMonths !== offer.contractMonths &&
                save({ contractMonths: form.contractMonths })
              }
            />
          </Field>

          <Field label="Rabat (%)" htmlFor="of-discount">
            <Input
              id="of-discount"
              type="number"
              min="0"
              max="100"
              step="0.1"
              className="h-8 tabular-nums"
              value={form.discountPct}
              disabled={!canEdit}
              onChange={(e) => setForm((p) => ({ ...p, discountPct: Number(e.target.value) }))}
              onBlur={() => form.discountPct !== offer.discountPct && save({ discountPct: form.discountPct })}
            />
          </Field>
        </div>
        </AutoCollapse>
        </Section>
        </CardContent>
      </Card>

      {/* --- Pasek dodawania sekcji --- */}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {OFFER_QUICK_CATEGORIES.map((cat) => (
            <Button key={cat} variant="outline" size="sm" onClick={() => setAddCategory(cat)}>
              <span
                className={cn("mr-1.5 h-2 w-2 rounded-full", OFFER_CATEGORY_UI[cat].bar)}
                aria-hidden
              />
              {OFFER_CATEGORY_META[cat].label}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => setAddCategory("inne")}>
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
              paramLabels={paramLabelsFor(section.packageId)}
              onUpdateSection={async (patch) => {
                const res = await offersApi.updateSection(offer.id, section.id, patch);
                if (res.data) onChange(res.data);
              }}
              onReexpand={async (params) => {
                const res = await offersApi.reexpandSection(offer.id, section.id, params);
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
        <CardContent className="p-3">
          <Section
            id="of-lease"
            icon={Wallet}
            title="Dzierżawa sprzętu"
            summary={leaseSummary}
            open={openHead.lease}
            onToggle={() => setOpenHead((p) => ({ ...p, lease: !p.lease }))}
          >
          <AutoCollapse onLeave={() => setOpenHead((p) => ({ ...p, lease: false }))}>
          <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Okres" htmlFor="of-lease-mode">
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
            </Field>

            {form.leaseMode === "custom" && (
              <Field label="Miesięcy" htmlFor="of-lease-months">
                <Input
                  id="of-lease-months"
                  type="number"
                  min="1"
                  className="h-9 tabular-nums"
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
              </Field>
            )}

            <Field label="Procent roczny" htmlFor="of-lease-rate">
              <Input
                id="of-lease-rate"
                type="number"
                min="0"
                step="0.1"
                className="h-9 tabular-nums"
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
            </Field>

            <Field label="Podstawa">
              <span className="flex h-8 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={form.leaseIncludeLabour}
                  disabled={!canEdit || form.leaseMode === "none"}
                  onChange={(e) => save({ leaseIncludeLabour: e.target.checked })}
                />
                Z robocizną
              </span>
            </Field>
          </div>

          {leaseActive && (
            <p className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
              Podstawa <strong className="tabular-nums">{fmtPln(totals.leaseBase)}</strong> ×{" "}
              {fmtPct(offer.leaseAnnualRate)} rocznie ÷ 12 ={" "}
              <strong className="tabular-nums">{fmtPln(totals.leaseMonthly)}</strong> / mies.
              {offer.leaseMonthsEffective ? ` przez ${offer.leaseMonthsEffective} mies.` : ""}
            </p>
          )}
          </AutoCollapse>
          </Section>
        </CardContent>
      </Card>

      {/* --- Uwagi --- */}
      <Card>
        <CardContent className="p-3">
          <Section
            id="of-notes-sec"
            icon={StickyNote}
            title="Uwagi na ofercie"
            summary={form.notes.trim() ? form.notes.trim().slice(0, 80) : "brak"}
            open={openHead.notes}
            onToggle={() => setOpenHead((p) => ({ ...p, notes: !p.notes }))}
          >
          <Textarea
            id="of-notes"
            rows={3}
            value={form.notes}
            disabled={!canEdit}
            onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
            onBlur={() => form.notes !== (offer.notes ?? "") && save({ notes: form.notes })}
          />
          </Section>
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 lg:px-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Zleceniodawca — płaci
            </div>
            <div className="flex flex-wrap items-start gap-x-5 gap-y-1">
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
              {/* WARTOŚĆ KONTRAKTU: jednorazowe + wszystko, co spłynie przez
                  przewidywany czas trwania. Dopiero ta liczba mówi, ile warta
                  jest oferta z abonamentem — sama rata niczego nie porządkuje. */}
              <Sum
                label={`Wartość kontraktu (${totals.marginHorizonMonths} mies.)`}
                value={fmtPln(totals.horizonRevenue)}
                strong
                hint={horizonHint}
              />
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
               mówi „to nie idzie do klienta".

               TRZY BLOKI, NIE JEDEN: „wykłada i zarabia" mieszało pieniądze
               wydane z zarobionymi, a zysk firmy z zarobkiem handlowca. Przy
               prowizji od przychodu to trzy różne kwoty i tak samo trzy różne
               decyzje: czy stać nas na wdrożenie, ile z tego zostaje firmie
               i ile kosztuje sprzedaż. */
            <div className="flex flex-wrap items-start gap-x-5 gap-y-2 rounded-md bg-muted/50 px-2.5 py-1">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Zleceniobiorca — koszt
                </div>
                <div className="flex flex-wrap items-start gap-x-5 gap-y-1">
                  <Sum
                    label="Wdrożenie"
                    value={fmtPlnOrDash(totals.oneTimeCost)}
                    hint={
                      totals.oneTimeCost === null || totals.oneTimeCost === undefined
                        ? "brak ceny zakupu na części pozycji"
                        : `sprzęt ${fmtPlnOrDash(totals.oneTimeCostMaterial)} · robocizna ${fmtPlnOrDash(
                            totals.oneTimeCostLabour
                          )}`
                    }
                  />
                  {totals.monthlyCost !== null &&
                    totals.monthlyCost !== undefined &&
                    totals.monthlyCost > 0 && (
                      <Sum
                        label="Koszt / mies."
                        value={fmtPln(totals.monthlyCost)}
                        hint="abonamenty, łącza, interwencje"
                      />
                    )}
                  <Sum
                    label={`Razem (${totals.marginHorizonMonths} mies.)`}
                    value={fmtPlnOrDash(totals.horizonCost)}
                    hint="wdrożenie + koszty miesięczne w całym okresie"
                  />
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Zleceniobiorca — zysk
                </div>
                <div className="flex flex-wrap items-start gap-x-5 gap-y-1">
                  <Sum
                    label="Zysk firmy"
                    value={fmtPlnOrDash(totals.companyProfit)}
                    strong
                    hint={
                      totals.companyProfit === null || totals.companyProfit === undefined
                        ? "brak kosztu na części pozycji"
                        : totals.salesCommission
                          ? `zysk ${fmtPln(totals.margin?.amount ?? 0)} − prowizja ${fmtPln(
                              totals.salesCommission
                            )} (${fmtPct(totals.salesCommissionPct)} od zysku)`
                          : `przez ${totals.marginHorizonMonths} mies., bez prowizji handlowca`
                    }
                  />
                  {totals.companyProfit !== null && totals.companyProfit !== undefined && (
                    <Sum
                      label="Zysk / mies."
                      value={fmtPln(totals.companyProfit / (totals.marginHorizonMonths || 1))}
                      hint={`średnio przez ${totals.marginHorizonMonths} mies. — ${horizonHint}`}
                    />
                  )}
                  {totals.margin !== undefined && (
                    <Sum
                      label={`Marża (${totals.marginHorizonMonths} mies.)`}
                      value={totals.margin ? fmtPct(totals.margin.marginPct) : "—"}
                      danger={!!totals.belowMinMargin}
                      hint={
                        totals.companyProfitPct !== null && totals.companyProfitPct !== undefined
                          ? `po prowizji ${fmtPct(totals.companyProfitPct)}`
                          : items.length === 0
                            ? "oferta nie ma jeszcze pozycji"
                            : "brak kosztu na części pozycji"
                      }
                    />
                  )}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Handlowiec — zysk
                </div>
                <div className="flex flex-wrap items-start gap-x-5 gap-y-1">
                  <Sum
                    label={
                      totals.salesCommissionPct
                        ? `Prowizja ${fmtPct(totals.salesCommissionPct)}`
                        : "Prowizja"
                    }
                    value={fmtPlnOrDash(totals.salesCommission)}
                    hint={
                      !offer.salespersonId
                        ? "oferta nie ma przypisanego handlowca"
                        : !totals.salesCommissionPct
                          ? "handlowiec nie ma stawki prowizji w kartotece"
                          : totals.salesCommission === null || totals.salesCommission === undefined
                            ? "bez znanego kosztu nie da się policzyć zysku, więc i prowizji"
                            : `${fmtPct(totals.salesCommissionPct)} od zysku ${fmtPln(
                                totals.margin?.amount ?? 0
                              )} przez ${totals.marginHorizonMonths} mies.`
                    }
                  />
                </div>
              </div>
            </div>
          )}
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

/**
 * Pole z etykietą OBOK, nie nad — nagłówek oferty to dziewięć pól, które
 * ustawia się raz. Etykieta nad polem kosztowała 24 px na wiersz, czyli tyle,
 * ile sama treść; w układzie „etykieta : pole" cała sekcja klienta mieści się
 * w jednym wierszu.
 */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex min-w-0 items-center gap-2 text-xs"
      {...(hint ? tip(hint) : {})}
    >
      <span className="w-24 shrink-0 text-right text-muted-foreground">
        {label}
        {hint && <span className="ml-0.5 text-muted-foreground/60">ⓘ</span>}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/**
 * Zwija sekcję, gdy fokus wychodzi poza nią — „po edycji chowaj".
 *
 * Reagujemy na wyjście fokusu z CAŁEJ sekcji, nie na blur pojedynczego pola:
 * przechodzenie tabulatorem między „Kontrahent" a „Obiekt" ma zostawić sekcję
 * otwartą, a dopiero kliknięcie w pozycje oferty ją schować.
 */
function AutoCollapse({ onLeave, children }: { onLeave: () => void; children: ReactNode }) {
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );
  return (
    <div
      onFocus={() => {
        if (timer.current) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        /*
         * Zwłoka jak w OfferItemPicker: zwinięcie sekcji skraca stronę o ~200 px,
         * a dzieje się to MIĘDZY mousedown a mouseup. Bez opóźnienia kliknięcie
         * w cokolwiek pod sekcją lądowało w pustce, bo cel zdążył uciec do góry.
         */
        timer.current = window.setTimeout(onLeave, 150);
      }}
    >
      {children}
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
    <div className="min-w-[7rem]" {...(hint ? tip(hint) : {})}>
      <div className="text-[11px] leading-tight text-muted-foreground">
        {label}
        {hint && <span className="ml-0.5 text-muted-foreground/60">ⓘ</span>}
      </div>
      <div
        className={cn(
          "tabular-nums leading-tight",
          strong ? "text-base font-semibold" : "text-sm font-medium",
          danger && "text-red-600"
        )}
      >
        {danger && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}
        {value}
      </div>
    </div>
  );
}
