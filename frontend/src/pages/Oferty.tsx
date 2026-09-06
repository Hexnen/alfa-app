/**
 * Oferty (dział techniczny) — lista, edytor i biblioteka pakietów.
 *
 * Katalogi (magazyn, usługi, handlowcy, spółki) ładujemy RAZ przy wejściu na
 * stronę i podajemy w dół: edytor odpytuje je przy każdym wyszukiwaniu pozycji,
 * a są to małe słowniki, które w trakcie składania oferty i tak się nie zmieniają.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlignLeft, FileText, Package, Plus, Trash2, Pencil, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { tip } from "@/components/ui/tooltip";
import {
  getCompanies,
  getSalespeople,
  offersApi,
  servicesApi,
  warehouseApi,
  type Company,
  type OfferDetail,
  type OfferListRow,
  type OfferPackage,
  type OfferPackageDetail,
  type OfferStatus,
  type OfferText,
  type Salesperson,
  type Service,
  type StockEntry,
  type WarehouseItem,
} from "@/lib/api";
import { fmtRelative, fmtTimestamp, pillClass } from "@/lib/calendar-labels";
import { OfferEditor } from "@/components/offers/OfferEditor";
import { PackageEditor } from "@/components/offers/PackageEditor";
import { TextEditor } from "@/components/offers/TextEditor";
import {
  OFFER_CATEGORY_META,
  OFFER_KIND_LABEL,
  OFFER_STATUS_META,
  fmtPct,
  fmtPln,
  offerSlug,
  scopeLabel,
} from "@/components/offers/offersShared";

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

const selectClass =
  "flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm";

/** Pierwsze ~80 znaków treści opisu w jednej linii — tyle, żeby poznać wzorzec. */
const excerpt = (body: string): string => {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  if (!flat) return "— pusta treść —";
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
};

export function Oferty() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/oferty");
  /*
   * OFERTA MA WŁASNY ADRES (/technical/oferty/of202608014), a nie stan lokalny:
   * link do dokumentu daje się wysłać na maila, odświeżenie strony zostaje na
   * ofercie, a „wstecz" w przeglądarce wraca na listę. W URL-u stoi NUMER —
   * to jego widzi klient na wydruku — a nie techniczne id.
   */
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [tab, setTab] = useState("oferty");
  const [rows, setRows] = useState<OfferListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OfferDetail | null>(null);

  // Słowniki
  const [packages, setPackages] = useState<OfferPackage[]>([]);
  /** Biblioteka powtarzalnych opisów handlowych — działa jak pakiety, tylko tekstowa. */
  const [texts, setTexts] = useState<OfferText[]>([]);
  const [warehouseItems, setWarehouseItems] = useState<WarehouseItem[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [minMarginPct, setMinMarginPct] = useState(0);
  /** Domyślny procent roczny dzierżawy z ustawień firmy (fabrycznie 117%). */
  const [defaultLeaseRate, setDefaultLeaseRate] = useState(0);

  const [pkgFormOpen, setPkgFormOpen] = useState(false);
  const [editingPkg, setEditingPkg] = useState<OfferPackageDetail | null>(null);
  const [textFormOpen, setTextFormOpen] = useState(false);
  const [editingText, setEditingText] = useState<OfferText | null>(null);
  /** Słowniki, których nie udało się wczytać — mówimy o tym wprost, zamiast po cichu degradować. */
  const [unavailable, setUnavailable] = useState<string[]>([]);

  const loadOffers = useCallback(async () => {
    try {
      const res = await offersApi.list();
      setRows(res.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania ofert");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPackages = useCallback(async () => {
    const res = await offersApi.listPackages();
    setPackages(res.data || []);
  }, []);

  const loadTexts = useCallback(async () => {
    const res = await offersApi.listTexts();
    setTexts(res.data || []);
  }, []);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  /*
   * Słowniki ładujemy NIEZALEŻNIE od siebie (`allSettled`, nie `all`).
   *
   * Przy `Promise.all` jedno 403 — na przykład z magazynu, do którego handlowiec
   * nie musi mieć dostępu — odrzucało całą paczkę i NIC się nie ustawiało:
   * znikali handlowcy, spółki (a z nimi stopka z NIP-em na wydruku), pakiety
   * i próg marży. Komentarz obiecywał „najwyżej uboższą wyszukiwarkę", a moduł
   * stawał się bezużyteczny. Teraz brak jednego uprawnienia zabiera dokładnie
   * to, czego dotyczy.
   */
  useEffect(() => {
    (async () => {
      const [pkgs, txts, items, svcs, sales, comps, stockRes, cfg] = await Promise.allSettled([
        offersApi.listPackages(),
        offersApi.listTexts(),
        warehouseApi.getItems(),
        servicesApi.list(),
        getSalespeople(true),
        getCompanies(true),
        warehouseApi.getStock(),
        offersApi.config(),
      ]);
      const failed: string[] = [];
      const take = <T,>(
        r: PromiseSettledResult<{ data?: T }>,
        label: string,
        set: (v: T) => void
      ) => {
        if (r.status === "fulfilled") {
          if (r.value.data !== undefined) set(r.value.data);
        } else {
          failed.push(label);
        }
      };

      take(pkgs, "pakiety", (v) => setPackages(v));
      take(txts, "opisy", (v) => setTexts(v));
      take(items, "magazyn", (v) => setWarehouseItems(v));
      take(svcs, "usługi", (v) => setServices(v));
      take(sales, "handlowcy", (v) => setSalespeople(v));
      take(comps, "spółki", (v) => setCompanies(v));
      take(stockRes, "stany magazynowe", (v) => setStock(v));
      if (cfg.status === "fulfilled") {
        setMinMarginPct(cfg.value.data?.minMarginPct ?? 0);
        setDefaultLeaseRate(cfg.value.data?.leaseAnnualRate ?? 0);
      } else {
        failed.push("ustawienia ofert");
      }

      setUnavailable(failed);
    })();
  }, []);

  const stockByItem = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of stock) m.set(s.itemId, (m.get(s.itemId) ?? 0) + s.quantity);
    return m;
  }, [stock]);

  /** Wejście w ofertę to nawigacja — resztę robi efekt czytający `slug`. */
  const openOffer = (number: string) => navigate(`/technical/oferty/${offerSlug(number)}`);

  /*
   * Adres → dokument. Jedno miejsce, w którym oferta się wczytuje: wejście
   * z listy, z linku i po odświeżeniu przechodzą tą samą ścieżką.
   */
  useEffect(() => {
    if (!slug) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await offersApi.getByNumber(slug);
        if (cancelled || !res.data) return;
        setDetail(res.data);
        setOpenId(res.data.offer.id);
      } catch (err) {
        if (cancelled) return;
        alertError(err, "Nie znaleziono oferty pod tym adresem");
        navigate("/technical/oferty", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, navigate]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((o) => !statusFilter || o.status === statusFilter)
      .filter(
        (o) =>
          !q ||
          o.number.toLowerCase().includes(q) ||
          o.clientName.toLowerCase().includes(q) ||
          o.site.toLowerCase().includes(q)
      );
  }, [rows, search, statusFilter]);

  const createOffer = async () => {
    try {
      const res = await offersApi.create({ date: new Date().toISOString().slice(0, 10) });
      await loadOffers();
      if (res.data) openOffer(res.data.number);
    } catch (err) {
      alertError(err, "Nie udało się utworzyć oferty");
    }
  };

  const removeOffer = async (o: OfferListRow) => {
    if (!window.confirm(`Usunąć ofertę ${o.number} razem z pozycjami?`)) return;
    try {
      await offersApi.remove(o.id);
      await loadOffers();
    } catch (err) {
      alertError(err, "Nie udało się usunąć oferty");
    }
  };

  // --- Widok edytora (osobny ekran, nie dialog: dokument bywa długi) ---
  if (openId !== null && detail) {
    return (
      <div className="space-y-4">
        {!editable && <ReadOnlyBanner className="mb-4" />}
        <OfferEditor
          detail={detail}
          editable={editable}
          minMarginPct={minMarginPct}
          defaultLeaseRate={defaultLeaseRate}
          packages={packages}
          texts={texts}
          warehouseItems={warehouseItems}
          services={services}
          salespeople={salespeople}
          companies={companies}
          stockByItem={stockByItem}
          onChange={(next) => {
            setDetail(next);
            loadOffers();
            // „Nowa wersja" tworzy INNY dokument (OF/…-w2) — adres musi za nim
            // pójść, inaczej odświeżenie wróciłoby do wersji poprzedniej.
            if (offerSlug(next.offer.number) !== slug) {
              navigate(`/technical/oferty/${offerSlug(next.offer.number)}`, { replace: true });
            }
          }}
          onBack={() => navigate("/technical/oferty")}
          onReloadPackages={loadPackages}
        />
      </div>
    );
  }

  // --- Widok edytora pakietu (osobny ekran jak edytor oferty: przepis bywa
  // długi, a wiersz ma sześć nastaw i w oknie modalnym nie mieścił się w linii) ---
  if (pkgFormOpen) {
    return (
      <div className="space-y-4">
        {!editable && <ReadOnlyBanner className="mb-4" />}
        <PackageEditor
          key={editingPkg?.id ?? "new"}
          pkg={editingPkg}
          warehouseItems={warehouseItems}
          services={services}
          onBack={() => setPkgFormOpen(false)}
          onSubmit={async (data) => {
            if (editingPkg) await offersApi.updatePackage(editingPkg.id, data);
            else await offersApi.createPackage(data);
            await loadPackages();
          }}
        />
      </div>
    );
  }

  // --- Widok edytora opisu (osobny ekran: treść pisze się obok podglądu
  // wydruku, a w oknie modalnym te dwie kolumny nie miały gdzie stanąć) ---
  if (textFormOpen) {
    return (
      <div className="space-y-4">
        {!editable && <ReadOnlyBanner className="mb-4" />}
        <TextEditor
          key={editingText?.id ?? "new"}
          text={editingText}
          onBack={() => setTextFormOpen(false)}
          onSubmit={async (data) => {
            if (editingText) await offersApi.updateText(editingText.id, data);
            else await offersApi.createText(data);
            await loadTexts();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Oferty</h1>
        <p className="text-sm text-muted-foreground">
          Oferty dla klientów na rozbudowy, montaże i serwisy — sprzęt z magazynu,
          robocizna z usług, abonament i dzierżawa w jednym dokumencie.
        </p>
      </div>

      {!editable && <ReadOnlyBanner className="mb-4" />}

      {unavailable.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          Nie masz dostępu do części danych ({unavailable.join(", ")}) — moduł
          działa, ale te elementy będą puste. Poproś administratora o brakujące
          uprawnienia.
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="oferty">
            <FileText className="mr-1 h-4 w-4" /> Oferty
          </TabsTrigger>
          <TabsTrigger value="pakiety">
            <Package className="mr-1 h-4 w-4" /> Pakiety
          </TabsTrigger>
          <TabsTrigger value="opisy">
            <AlignLeft className="mr-1 h-4 w-4" /> Opisy
          </TabsTrigger>
        </TabsList>

        {/* --- Lista ofert --- */}
        <TabsContent value="oferty" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Szukaj po numerze, kliencie, obiekcie…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <select
              className={selectClass}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Wszystkie statusy</option>
              {(Object.keys(OFFER_STATUS_META) as OfferStatus[]).map((s) => (
                <option key={s} value={s}>
                  {OFFER_STATUS_META[s].label}
                </option>
              ))}
            </select>
            {editable && (
              <Button className="ml-auto" onClick={createOffer}>
                <Plus className="mr-1 h-4 w-4" /> Nowa oferta
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Numer</th>
                      <th className="px-3 py-2 font-medium">Klient / obiekt</th>
                      <th className="px-3 py-2 font-medium">Zakres</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Handlowiec</th>
                      <th className="px-3 py-2 font-medium">Utworzył</th>
                      <th className="px-3 py-2 font-medium">Zmieniono</th>
                      <th className="px-3 py-2 text-right font-medium">Jednorazowo</th>
                      <th className="px-3 py-2 text-right font-medium">Miesięcznie</th>
                      <th className="px-3 py-2 text-right font-medium">Marża</th>
                      {editable && <th className="px-3 py-2 text-right font-medium">Akcje</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={editable ? 11 : 10}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visible.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 11 : 10}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Brak ofert. Zacznij od „Nowa oferta”.
                        </td>
                      </tr>
                    ) : (
                      visible.map((o) => {
                        const meta = OFFER_STATUS_META[o.status];
                        return (
                          <tr
                            key={o.id}
                            className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                            onClick={() => openOffer(o.number)}
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium">{o.number}</div>
                              <div className="text-xs text-muted-foreground">{o.date}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div>{o.clientName || "—"}</div>
                              <div className="text-xs text-muted-foreground">{o.site}</div>
                            </td>
                            {/* Rodzaj pracy, a pod nim FAKTYCZNY zakres z treści
                                oferty — inaczej wszystkie montaże wyglądają
                                identycznie i nie widać, czy to CCTV, czy alarm. */}
                            <td className="px-3 py-2 text-muted-foreground">
                              <div>{OFFER_KIND_LABEL[o.kind]}</div>
                              {o.scope?.length > 0 && (
                                <div className="text-xs">
                                  {o.scope.map(scopeLabel).join(", ")}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span className={pillClass(meta.tone)}>{meta.label}</span>
                              {o.version > 1 && (
                                <span className={pillClass("neutral", { className: "ml-1" })}>
                                  w{o.version}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {o.salespersonName || <span className="text-muted-foreground">—</span>}
                            </td>
                            {/* Autor i data powstania w jednej kolumnie: to jedna
                                informacja („kto i kiedy to założył"), a osobna
                                kolumna na samą datę rozpychałaby tabelę. Pełny
                                znacznik czasu siedzi w tooltipie, bo „2 dni temu"
                                czyta się szybciej niż „30.08.2026 14:12". */}
                            <td className="px-3 py-2 text-xs">
                              <div>
                                {o.createdByLabel || (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </div>
                              <div
                                className="text-muted-foreground"
                                {...tip(fmtTimestamp(o.createdAt))}
                              >
                                {fmtRelative(o.createdAt)}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {o.updatedAt && o.updatedAt !== o.createdAt ? (
                                <span {...tip(fmtTimestamp(o.updatedAt))}>
                                  {fmtRelative(o.updatedAt)}
                                </span>
                              ) : (
                                <span {...tip("Dokument nie był zmieniany od utworzenia")}>—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {fmtPln(o.totals.oneTimePayable)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {fmtPln(o.totals.monthlyTotal)}
                            </td>
                            <td
                              className={`px-3 py-2 text-right tabular-nums ${
                                o.totals.belowMinMargin ? "font-semibold text-red-600" : ""
                              }`}
                            >
                              {o.totals.margin === undefined
                                ? "—"
                                : fmtPct(o.totals.margin?.marginPct)}
                            </td>
                            {editable && (
                              <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                                <div className="flex justify-end">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    title="Usuń ofertę"
                                    onClick={() => removeOffer(o)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Biblioteka pakietów --- */}
        <TabsContent value="pakiety" className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Zapisane zestawy, z których składa się ofertę jednym kliknięciem.
              Pakiet parametryczny skaluje ilości — np. jeden rejestrator na każde
              osiem kamer.
            </p>
            {editable && (
              <Button
                className="ml-auto shrink-0"
                onClick={() => {
                  setEditingPkg(null);
                  setPkgFormOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy pakiet
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Pakiet</th>
                      <th className="px-3 py-2 font-medium">Kategoria</th>
                      <th className="px-3 py-2 font-medium">Producent</th>
                      <th className="px-3 py-2 font-medium">Tryb</th>
                      <th className="px-3 py-2 text-right font-medium">Pozycji</th>
                      {editable && <th className="px-3 py-2 text-right font-medium">Akcje</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {packages.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 6 : 5}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Biblioteka jest pusta. Dodaj pakiet albo zapisz gotową
                          sekcję z oferty.
                        </td>
                      </tr>
                    ) : (
                      packages.map((p) => {
                        const meta = OFFER_CATEGORY_META[p.category];
                        return (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="px-3 py-2">
                              <div className="font-medium">{p.name}</div>
                              {p.description && (
                                <div className="text-xs text-muted-foreground">
                                  {p.description}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span className={pillClass(meta.tone)}>{meta.label}</span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {p.manufacturer || "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {p.mode === "parametric" ? "parametryczny" : "stały zestaw"}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {p.itemCount ?? 0}
                            </td>
                            {editable && (
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Edytuj"
                                    onClick={async () => {
                                      try {
                                        const res = await offersApi.getPackage(p.id);
                                        setEditingPkg(res.data ?? null);
                                        setPkgFormOpen(true);
                                      } catch (err) {
                                        alertError(err, "Błąd wczytywania pakietu");
                                      }
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    title="Archiwizuj"
                                    onClick={async () => {
                                      if (!window.confirm(`Zarchiwizować pakiet „${p.name}”?`))
                                        return;
                                      try {
                                        await offersApi.archivePackage(p.id);
                                        await loadPackages();
                                      } catch (err) {
                                        alertError(err, "Błąd archiwizacji pakietu");
                                      }
                                    }}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Biblioteka opisów --- */}
        <TabsContent value="opisy" className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Powtarzalne teksty handlowe — warunki gwarancji, zakres wsparcia,
              warunki płatności. Dołączenie na ofertę kopiuje treść, więc późniejsza
              poprawka wzorca nie zmieni dokumentu, który klient już dostał.
            </p>
            {editable && (
              <Button
                className="ml-auto shrink-0"
                onClick={() => {
                  setEditingText(null);
                  setTextFormOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy opis
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Opis</th>
                      <th className="px-3 py-2 font-medium">Kategoria</th>
                      <th className="px-3 py-2 font-medium">Domyślny</th>
                      {editable && <th className="px-3 py-2 text-right font-medium">Akcje</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {texts.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 4 : 3}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Biblioteka jest pusta. Dodaj opis, a będziesz go dokładać
                          na oferty jednym kliknięciem.
                        </td>
                      </tr>
                    ) : (
                      texts.map((t) => {
                        const meta = OFFER_CATEGORY_META[t.category];
                        return (
                          <tr key={t.id} className="border-b last:border-0">
                            <td className="px-3 py-2">
                              <div className="font-medium">{t.name}</div>
                              {/* Skrót z SUROWEJ treści — markery markdownu w tej
                                  linii mówią więcej o składni niż o tym, co w opisie
                                  stoi, a chodzi o rozpoznanie wzorca w dwie sekundy. */}
                              <div className="text-xs text-muted-foreground">
                                {excerpt(t.body)}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <span className={pillClass(meta.tone)}>{meta.label}</span>
                            </td>
                            <td className="px-3 py-2">
                              {t.isDefault ? (
                                <span className={pillClass("emerald")}>na każdej ofercie</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            {editable && (
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Edytuj"
                                    onClick={async () => {
                                      try {
                                        const res = await offersApi.getText(t.id);
                                        setEditingText(res.data ?? null);
                                        setTextFormOpen(true);
                                      } catch (err) {
                                        alertError(err, "Błąd wczytywania opisu");
                                      }
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    title="Archiwizuj"
                                    onClick={async () => {
                                      if (!window.confirm(`Zarchiwizować opis „${t.name}”?`))
                                        return;
                                      try {
                                        await offersApi.archiveText(t.id);
                                        await loadTexts();
                                      } catch (err) {
                                        alertError(err, "Błąd archiwizacji opisu");
                                      }
                                    }}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  );
}
