/**
 * Oferty (dział techniczny) — lista, edytor i biblioteka pakietów.
 *
 * Katalogi (magazyn, usługi, handlowcy, spółki) ładujemy RAZ przy wejściu na
 * stronę i podajemy w dół: edytor odpytuje je przy każdym wyszukiwaniu pozycji,
 * a są to małe słowniki, które w trakcie składania oferty i tak się nie zmieniają.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlignLeft,
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  FileText,
  Handshake,
  Package,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { tip } from "@/components/ui/tooltip";
import {
  getCompanies,
  getSalespeople,
  offersApi,
  salespersonName,
  servicesApi,
  warehouseApi,
  OFFER_KINDS,
  type Company,
  type OfferDetail,
  type OfferKind,
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
// Definicja marży mieszka w magazynie (tam się liczy) — oferta ma mówić to samo.
import { MARGIN_HELP } from "@/components/warehouse/warehouseShared";
import { cn } from "@/lib/utils";
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

/** Kolumny, po których da się sortować listę ofert. */
type OfferSortKey =
  | "number"
  | "client"
  | "scope"
  | "status"
  | "salesperson"
  | "lead"
  | "created"
  | "updated"
  | "oneTime"
  | "monthly"
  | "margin";

/**
 * Domyślny kierunek sortowania kolumny — kwoty, marże i daty ludzie czytają od
 * największej wartości (najnowsze/najdroższe u góry), teksty alfabetycznie
 * (jak w kartotece obiektów). Numer oferty jest tu po stronie „dat”: koduje rok
 * i miesiąc (OF/2026/08/014), więc malejąco = najnowsze u góry — dokładnie tak,
 * jak listę zwraca backend (`ORDER BY date DESC, id DESC`).
 */
const DEFAULT_DIR: Record<OfferSortKey, "asc" | "desc"> = {
  number: "desc",
  client: "asc",
  scope: "asc",
  status: "asc",
  salesperson: "asc",
  lead: "asc",
  created: "desc",
  updated: "desc",
  oneTime: "desc",
  monthly: "desc",
  margin: "desc",
};

/** Filtr kwoty miesięcznej: wszystkie / tylko z abonamentem / tylko bez. */
type ValueMode = "all" | "with" | "without";

/** Wartość w selekcie oznaczająca „oferty bez przypisania” (handlowiec, spółka). */
const NONE = "none";

/** Kwota z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data z bazy na liczbę do porównań; brak lub śmieć = wartość pusta (NULLS LAST). */
function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

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
  /*
   * WEJŚCIA Z KARTY SZANSY. `?leadId=` zakłada nową ofertę powiązaną z lejkiem
   * (backend uzupełnia klienta, NIP, obiekt, adres i handlowca), `?offerId=`
   * otwiera istniejącą — karta szansy linkuje ofertę po id, bo nie zna slugu.
   */
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState("oferty");
  const [rows, setRows] = useState<OfferListRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Filtry i sortowanie liczymy po stronie klienta — `offersApi.list()` i tak
  // zwraca całą listę (backend nie stronicuje), więc nie ma po co dokładać
  // parametrów do API. Z tego samego powodu widełki kwot idą bez debounce'u:
  // nie ma żądania do odciążenia, a lista przelicza się w tym samym renderze
  // co wpisana cyfra.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [salespersonFilter, setSalespersonFilter] = useState("all");
  const [leadFilter, setLeadFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [sort, setSort] = useState<OfferSortKey>("number");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

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

  /*
   * `?offerId=` i `?leadId=` obsługujemy RAZ (ref), a po zadziałaniu czyścimy
   * parametr z adresu — inaczej „wstecz” z otwartej oferty zakładałoby kolejną.
   */
  const queryHandled = useRef(false);
  useEffect(() => {
    if (queryHandled.current) return;
    const offerId = Number(searchParams.get("offerId"));
    const leadId = Number(searchParams.get("leadId"));
    if (!Number.isInteger(offerId) && !Number.isInteger(leadId)) return;
    queryHandled.current = true;
    (async () => {
      try {
        if (Number.isInteger(offerId) && offerId > 0) {
          const res = await offersApi.get(offerId);
          setSearchParams({}, { replace: true });
          if (res.data) navigate(`/technical/oferty/${offerSlug(res.data.offer.number)}`, { replace: true });
          return;
        }
        if (Number.isInteger(leadId) && leadId > 0) {
          // Nowa oferta Z SZANSY: klient, NIP, obiekt, adres i handlowca
          // uzupełnia backend (POST /offers z `leadId`), żeby prefill działał
          // tak samo z każdego miejsca, które ofertę zakłada.
          const res = await offersApi.create({
            date: new Date().toISOString().slice(0, 10),
            leadId,
          });
          setSearchParams({}, { replace: true });
          await loadOffers();
          if (res.data) navigate(`/technical/oferty/${offerSlug(res.data.number)}`, { replace: true });
        }
      } catch (err) {
        setSearchParams({}, { replace: true });
        alertError(err, "Nie udało się otworzyć oferty z karty szansy");
      }
    })();
  }, [searchParams, setSearchParams, navigate, loadOffers]);

  /**
   * Znaczniki zakresu do selecta budujemy z danych, a nie ze słownika: backend
   * liczy je z treści oferty (`scopeOf`) i może dorzucić tag spoza
   * `OFFER_SCOPE_LABEL` — wtedy i tak da się po nim odfiltrować.
   */
  /**
   * Szanse do selecta budujemy Z WIDOCZNYCH OFERT, a nie z kartoteki szans:
   * lejek stoi za osobnym uprawnieniem, a filtr ma pokazywać dokładnie te
   * szanse, które w tej liście da się wybrać.
   */
  const leadOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of rows) {
      if (o.leadId != null) m.set(o.leadId, o.leadTitle || `Szansa #${o.leadId}`);
    }
    return [...m.entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title, "pl"));
  }, [rows]);

  const scopeTags = useMemo(
    () =>
      Array.from(new Set(rows.flatMap((o) => o.scope ?? []))).sort((a, b) =>
        scopeLabel(a).localeCompare(scopeLabel(b), "pl")
      ),
    [rows]
  );

  /** Jeden przebieg: filtry + sortowanie. */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);

    const list = rows.filter((o) => {
      if (
        q &&
        ![o.number, o.clientName, o.site, o.salespersonName].some((v) =>
          (v ?? "").toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (kindFilter !== "all" && o.kind !== kindFilter) return false;
      if (scopeFilter !== "all" && !(o.scope ?? []).includes(scopeFilter)) return false;
      if (salespersonFilter !== "all") {
        if (
          salespersonFilter === NONE
            ? o.salespersonId !== null
            : String(o.salespersonId ?? "") !== salespersonFilter
        ) {
          return false;
        }
      }
      if (leadFilter !== "all") {
        if (
          leadFilter === NONE
            ? o.leadId != null
            : String(o.leadId ?? "") !== leadFilter
        ) {
          return false;
        }
      }
      if (companyFilter !== "all") {
        if (
          companyFilter === NONE
            ? o.companyId !== null
            : String(o.companyId ?? "") !== companyFilter
        ) {
          return false;
        }
      }
      // Kwota miesięczna 0 zł = oferta bez abonamentu i bez dzierżawy (sam
      // montaż jednorazowy), więc filtr „bez kwoty miesięcznej” łapie zero.
      const value = o.totals.monthlyTotal ?? 0;
      if (valueMode === "with" && value <= 0) return false;
      if (valueMode === "without" && value > 0) return false;
      if (min !== undefined && value < min) return false;
      if (max !== undefined && value > max) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (o: OfferListRow) =>
      sort === "number"
        ? o.number
        : sort === "client"
          ? o.clientName
          : sort === "scope"
            ? OFFER_KIND_LABEL[o.kind]
            : sort === "status"
              ? OFFER_STATUS_META[o.status].label
              : sort === "lead"
                ? (o.leadTitle ?? "")
                : (o.salespersonName ?? "");
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (o: OfferListRow): number | null => {
      switch (sort) {
        case "oneTime":
          return o.totals.oneTimePayable;
        case "monthly":
          return o.totals.monthlyTotal;
        case "margin":
          // Bez uprawnienia do kosztów backend wycina marżę — tabela pokazuje
          // wtedy kreskę, więc traktujemy ją jak wartość pustą.
          return o.totals.margin?.marginPct ?? null;
        case "created":
          return parseDate(o.createdAt);
        default:
          // „Zmieniono”: tabela pokazuje kreskę, dopóki nikt nie ruszył
          // dokumentu od utworzenia — traktujemy to jak brak wartości.
          return o.updatedAt && o.updatedAt !== o.createdAt ? parseDate(o.updatedAt) : null;
      }
    };

    const numeric =
      sort === "oneTime" ||
      sort === "monthly" ||
      sort === "margin" ||
      sort === "created" ||
      sort === "updated";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po handlowcu” zaczynałoby
    // się od ofert bez opiekuna. Remis rozstrzyga numer, żeby kolejność była
    // stabilna.
    const compare = (a: OfferListRow, b: OfferListRow): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort((a, b) => compare(a, b) || a.number.localeCompare(b.number, "pl"));
  }, [
    rows,
    search,
    statusFilter,
    kindFilter,
    scopeFilter,
    salespersonFilter,
    leadFilter,
    companyFilter,
    valueMode,
    minInput,
    maxInput,
    sort,
    dir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: OfferSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    statusFilter !== "all" ||
    kindFilter !== "all" ||
    scopeFilter !== "all" ||
    salespersonFilter !== "all" ||
    leadFilter !== "all" ||
    companyFilter !== "all" ||
    valueMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setKindFilter("all");
    setScopeFilter("all");
    setSalespersonFilter("all");
    setLeadFilter("all");
    setCompanyFilter("all");
    setValueMode("all");
    setMinInput("");
    setMaxInput("");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: OfferSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`oferty-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            activeCol ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
        </button>
      </th>
    );
  };

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
          {/* Licznik przy „Ofertach” pokazuje, ile wierszy zostało PO filtrach —
              inaczej zakładka mówiłaby co innego niż tabela pod nią. */}
          <TabsTrigger value="oferty">
            <FileText className="mr-1 h-4 w-4" /> Oferty ({visible.length})
          </TabsTrigger>
          <TabsTrigger value="pakiety">
            <Package className="mr-1 h-4 w-4" /> Pakiety ({packages.length})
          </TabsTrigger>
          <TabsTrigger value="opisy">
            <AlignLeft className="mr-1 h-4 w-4" /> Opisy ({texts.length})
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
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[190px]" data-testid="oferty-filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie statusy</SelectItem>
                {(Object.keys(OFFER_STATUS_META) as OfferStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {OFFER_STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Kolumna „Zakres” to dwie informacje naraz: rodzaj pracy (górna
                linia) i systemy z treści oferty (dolna) — stąd dwa filtry. */}
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="w-[200px]" data-testid="oferty-filter-kind">
                <SelectValue placeholder="Rodzaj" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie rodzaje</SelectItem>
                {OFFER_KINDS.map((k: OfferKind) => (
                  <SelectItem key={k} value={k}>
                    {OFFER_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="w-[180px]" data-testid="oferty-filter-scope">
                <SelectValue placeholder="Zakres" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie zakresy</SelectItem>
                {scopeTags.map((t) => (
                  <SelectItem key={t} value={t}>
                    {scopeLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={salespersonFilter} onValueChange={setSalespersonFilter}>
              <SelectTrigger className="w-[190px]" data-testid="oferty-filter-salesperson">
                <SelectValue placeholder="Handlowiec" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszyscy handlowcy</SelectItem>
                <SelectItem value={NONE}>Bez handlowca</SelectItem>
                {salespeople.map((sp) => (
                  <SelectItem key={sp.id} value={String(sp.id)}>
                    {salespersonName(sp)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {editable && (
              <Button className="ml-auto" onClick={createOffer}>
                <Plus className="mr-1 h-4 w-4" /> Nowa oferta
              </Button>
            )}
          </div>

          {/* Druga linia filtrów: spółka wystawiająca i kwota miesięczna
              (abonament + rata dzierżawy) — tryb i widełki. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Szansa sprzedaży, z której oferta wyszła. „Bez szansy” to
                dokumenty spoza lejka (rozbudowy, serwisy dla stałych klientów). */}
            {leadOptions.length > 0 && (
              <Select value={leadFilter} onValueChange={setLeadFilter}>
                <SelectTrigger className="w-[200px]" data-testid="oferty-filter-lead">
                  <SelectValue placeholder="Szansa" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Wszystkie szanse</SelectItem>
                  <SelectItem value={NONE}>Bez szansy</SelectItem>
                  {leadOptions.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger className="w-[180px]" data-testid="oferty-filter-company">
                <SelectValue placeholder="Spółka" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie spółki</SelectItem>
                <SelectItem value={NONE}>Bez spółki</SelectItem>
                {companies.map((co) => (
                  <SelectItem key={co.id} value={String(co.id)}>
                    {co.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
              <SelectTrigger className="w-[220px]" data-testid="oferty-filter-value-mode">
                <SelectValue placeholder="Kwota miesięczna" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Kwota mies.: wszystkie</SelectItem>
                <SelectItem value="with">Tylko z kwotą miesięczną</SelectItem>
                <SelectItem value="without">Tylko jednorazowe</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Kwota od</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="oferty-filter-min"
                value={minInput}
                onChange={(e) => setMinInput(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="oferty-filter-max"
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
              />
              <span>zł/mies.</span>
            </div>
            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                data-testid="oferty-filters-clear"
              >
                <X className="h-4 w-4 mr-1" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <SortHeader
                        label="Numer"
                        sortKey="number"
                        title="Numer koduje rok i miesiąc, więc malejąco = najnowsze oferty u góry"
                      />
                      <SortHeader label="Klient / obiekt" sortKey="client" />
                      <SortHeader
                        label="Zakres"
                        sortKey="scope"
                        title="Sortowanie po rodzaju pracy (montaż, rozbudowa, serwis)"
                      />
                      <SortHeader label="Status" sortKey="status" />
                      <SortHeader
                        label="Handlowiec"
                        sortKey="salesperson"
                        title="Oferty bez opiekuna idą na koniec"
                      />
                      <SortHeader
                        label="Szansa"
                        sortKey="lead"
                        title="Oferty spoza lejka handlowego idą na koniec"
                      />
                      <SortHeader label="Utworzył" sortKey="created" />
                      <SortHeader
                        label="Zmieniono"
                        sortKey="updated"
                        title="Dokumenty nieruszane od utworzenia idą na koniec"
                      />
                      <SortHeader label="Jednorazowo" sortKey="oneTime" align="right" />
                      <SortHeader label="Miesięcznie" sortKey="monthly" align="right" />
                      <SortHeader
                        label="Marża"
                        sortKey="margin"
                        align="right"
                        title={`${MARGIN_HELP} Sortowanie po marży procentowej; oferty bez policzonej marży idą na koniec.`}
                      />
                      {editable && <th className="px-3 py-2 text-right font-medium">Akcje</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={editable ? 12 : 11}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visible.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 12 : 11}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          {filtersActive
                            ? "Brak ofert dla wybranych filtrów"
                            : "Brak ofert. Zacznij od „Nowa oferta”."}
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
                            {/* Link prowadzi do karty szansy, więc klik nie może
                                otworzyć jeszcze oferty pod spodem (wiersz jest klikalny). */}
                            <td className="px-3 py-2 text-xs" onClick={(e) => e.stopPropagation()}>
                              {o.leadId ? (
                                <Link
                                  to={`/handlowy/leady/${o.leadId}`}
                                  className="inline-flex items-center gap-1 text-primary hover:underline"
                                  data-testid="oferty-lead-link"
                                >
                                  <Handshake className="h-3 w-3 shrink-0" />
                                  <span className="max-w-[12rem] truncate">
                                    {o.leadTitle || `#${o.leadId}`}
                                  </span>
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
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
