import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { RealizationForm } from "@/components/RealizationForm";
import { TechnicianForm } from "@/components/TechnicianForm";
import { TechnicalObjects } from "@/components/TechnicalObjects";
import { PriceItemForm } from "@/components/PriceItemForm";
import { ProtocolForm } from "@/components/ProtocolForm";
import { QuoteForm } from "@/components/QuoteForm";
import { printProtocol } from "@/lib/protocolPrint";
import { printQuote } from "@/lib/quotePrint";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Printer,
} from "lucide-react";
import {
  getRealizations,
  getRealizationSummary,
  createRealization,
  updateRealization,
  deleteRealization,
  getTechnicians,
  createTechnician,
  updateTechnician,
  deleteTechnician,
  getPriceList,
  createPriceItem,
  updatePriceItem,
  deletePriceItem,
  getProtocols,
  syncProtocols,
  updateProtocol,
  signProtocol,
  unsignProtocol,
  getQuotes,
  createQuote,
  updateQuote,
  deleteQuote,
  type Realization,
  type RealizationInput,
  type RealizationSummary,
  type Technician,
  type TechnicianInput,
  type PriceItem,
  type PriceItemInput,
  type Protocol,
  type ProtocolInput,
  type Quote,
  type QuoteInput,
} from "@/lib/api";

const MONTH_NAMES = [
  "Styczeń",
  "Luty",
  "Marzec",
  "Kwiecień",
  "Maj",
  "Czerwiec",
  "Lipiec",
  "Sierpień",
  "Wrzesień",
  "Październik",
  "Listopad",
  "Grudzień",
];

const KIND_META: Record<string, { label: string; badge: string }> = {
  service: {
    label: "Serwis płatny",
    badge: "bg-emerald-100 text-emerald-700",
  },
  warranty: {
    label: "Gwarancyjny",
    badge: "bg-amber-100 text-amber-700",
  },
  installation: {
    label: "Montaż",
    badge: "bg-violet-100 text-violet-700",
  },
};

const PROTOCOL_TYPE_META: Record<string, { label: string; badge: string }> = {
  serwis: { label: "Serwis", badge: "bg-emerald-100 text-emerald-700" },
  montaz: { label: "Montaż", badge: "bg-violet-100 text-violet-700" },
  wizja: { label: "Wizja lokalna", badge: "bg-sky-100 text-sky-700" },
  inne: { label: "Inne", badge: "bg-muted text-muted-foreground" },
};

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});
const money = (v: number | null | undefined) => pln.format(Number(v || 0));

const TECH_TABS = [
  "realizacje",
  "protokoly",
  "wyceny",
  "cennik",
  "technicy",
  "obiekty",
] as const;

export function Technical() {
  const { tab } = useParams<{ tab: string }>();
  const { canEdit } = usePerms();
  const editable = canEdit(`technical/${tab}`);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [rows, setRows] = useState<Realization[]>([]);
  const [summary, setSummary] = useState<RealizationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Realization | null>(null);

  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [techLoading, setTechLoading] = useState(true);
  const [techFormOpen, setTechFormOpen] = useState(false);
  const [editingTech, setEditingTech] = useState<Technician | null>(null);

  const [priceItems, setPriceItems] = useState<PriceItem[]>([]);
  const [priceLoading, setPriceLoading] = useState(true);
  const [priceFormOpen, setPriceFormOpen] = useState(false);
  const [editingPrice, setEditingPrice] = useState<PriceItem | null>(null);

  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [protoLoading, setProtoLoading] = useState(true);
  const [editingProto, setEditingProto] = useState<Protocol | null>(null);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, summaryRes] = await Promise.all([
        getRealizations(year, month),
        getRealizationSummary(year, month),
      ]);
      setRows(listRes.data || []);
      setSummary(summaryRes.data || null);
    } catch (error) {
      console.error("Error loading realizations:", error);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    load();
  }, [load]);

  const loadTechnicians = useCallback(async () => {
    setTechLoading(true);
    try {
      const res = await getTechnicians();
      setTechnicians(res.data || []);
    } catch (error) {
      console.error("Error loading technicians:", error);
    } finally {
      setTechLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTechnicians();
  }, [loadTechnicians]);

  const handleTechCreate = async (data: TechnicianInput) => {
    if (!editable) return;
    await createTechnician(data);
    loadTechnicians();
  };

  const handleTechUpdate = async (data: TechnicianInput) => {
    if (!editable) return;
    if (editingTech) {
      await updateTechnician(editingTech.id, data);
      loadTechnicians();
    }
  };

  const handleTechDelete = async (tech: Technician) => {
    if (!editable) return;
    if (
      window.confirm(
        `Usunąć technika "${`${tech.firstName} ${tech.lastName}`.trim()}"?`
      )
    ) {
      try {
        await deleteTechnician(tech.id);
        loadTechnicians();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć technika"
        );
      }
    }
  };

  const closeTechForm = () => {
    setTechFormOpen(false);
    setEditingTech(null);
  };

  // --- Cennik ---
  const loadPriceList = useCallback(async () => {
    setPriceLoading(true);
    try {
      const res = await getPriceList();
      setPriceItems(res.data || []);
    } catch (error) {
      console.error("Error loading price list:", error);
    } finally {
      setPriceLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPriceList();
  }, [loadPriceList]);

  const handlePriceCreate = async (data: PriceItemInput) => {
    if (!editable) return;
    await createPriceItem(data);
    loadPriceList();
  };

  const handlePriceUpdate = async (data: PriceItemInput) => {
    if (!editable) return;
    if (editingPrice) {
      await updatePriceItem(editingPrice.id, data);
      loadPriceList();
    }
  };

  const handlePriceDelete = async (item: PriceItem) => {
    if (!editable) return;
    if (window.confirm(`Usunąć pozycję "${item.name}" z cennika?`)) {
      try {
        await deletePriceItem(item.id);
        loadPriceList();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć pozycji"
        );
      }
    }
  };

  const closePriceForm = () => {
    setPriceFormOpen(false);
    setEditingPrice(null);
  };

  // --- Protokoły (generowane automatycznie z realizacji) ---
  const loadProtocols = useCallback(async () => {
    setProtoLoading(true);
    try {
      // dociągnij protokoły dla realizacji, które jeszcze ich nie mają
      await syncProtocols().catch(() => {});
      const res = await getProtocols(year, month);
      setProtocols(res.data || []);
    } catch (error) {
      console.error("Error loading protocols:", error);
    } finally {
      setProtoLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    loadProtocols();
  }, [loadProtocols]);

  // --- Wyceny ---
  const loadQuotes = useCallback(async () => {
    setQuotesLoading(true);
    try {
      const res = await getQuotes(year);
      setQuotes(res.data || []);
    } catch (error) {
      console.error("Error loading quotes:", error);
    } finally {
      setQuotesLoading(false);
    }
  }, [year]);

  useEffect(() => {
    loadQuotes();
  }, [loadQuotes]);

  const handleQuoteNew = async () => {
    if (!editable) return;
    try {
      const res = await createQuote();
      await loadQuotes();
      if (res.data) setEditingQuote(res.data);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Nie można utworzyć wyceny"
      );
    }
  };

  const handleQuoteUpdate = async (data: QuoteInput) => {
    if (!editable) return;
    if (editingQuote) {
      await updateQuote(editingQuote.id, data);
      loadQuotes();
    }
  };

  const handleQuoteDelete = async (quote: Quote) => {
    if (!editable) return;
    if (window.confirm(`Usunąć wycenę ${quote.number}?`)) {
      try {
        await deleteQuote(quote.id);
        loadQuotes();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć wyceny"
        );
      }
    }
  };

  const handleProtoUpdate = async (data: ProtocolInput) => {
    if (!editable) return;
    if (editingProto) {
      await updateProtocol(editingProto.id, data);
      loadProtocols();
    }
  };

  const handleProtoSign = async (signaturePng: string, signerName: string) => {
    if (!editable) return;
    if (editingProto) {
      const res = await signProtocol(editingProto.id, {
        signaturePng,
        signerName,
      });
      if (res.data) setEditingProto(res.data);
      loadProtocols();
    }
  };

  const handleProtoUnsign = async () => {
    if (!editable) return;
    if (editingProto) {
      const res = await unsignProtocol(editingProto.id);
      if (res.data) setEditingProto(res.data);
      loadProtocols();
    }
  };


  const shiftMonth = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  };

  const handleCreate = async (data: RealizationInput) => {
    if (!editable) return;
    await createRealization(data);
    load();
  };

  const handleUpdate = async (data: RealizationInput) => {
    if (!editable) return;
    if (editing) {
      await updateRealization(editing.id, data);
      load();
    }
  };

  const handleDelete = async (row: Realization) => {
    if (!editable) return;
    if (
      window.confirm(
        `Usunąć realizację "${row.site}" z ${new Date(row.date).toLocaleDateString("pl-PL")}?`
      )
    ) {
      try {
        await deleteRealization(row.id);
        load();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć realizacji"
        );
      }
    }
  };

  const openEdit = (row: Realization) => {
    setEditing(row);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const defaultDate = `${year}-${String(month).padStart(2, "0")}-${String(
    Math.min(now.getDate(), 28)
  ).padStart(2, "0")}`;

  const tiles = summary
    ? [
        {
          label: "Serwisy płatne",
          value: money(summary.paidServices),
          sub: `${summary.counts.service} szt.`,
        },
        {
          label: "Montaże",
          value: money(summary.installations),
          sub: `${summary.counts.installation} szt.`,
        },
        {
          label: "Przychód razem",
          value: money(summary.revenue),
          sub: "płatne + montaże",
          accent: true,
        },
        {
          label: "Bezpłatne (potencjalny przychód)",
          value: money(summary.freePotential),
          sub: `${summary.counts.warranty} szt.`,
        },
        {
          label: "Strata (koszt bezpłatnych)",
          value: money(summary.freeCost),
          sub: "roboczogodziny",
        },
        {
          label: "Suma sum",
          value: money(summary.grandTotal),
          sub: "z bezpłatnymi",
        },
      ]
    : [];

  if (!tab || !TECH_TABS.includes(tab as (typeof TECH_TABS)[number])) {
    return <Navigate to="/technical/realizacje" replace />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Techniczny</h1>
      </div>

      {!editable && <ReadOnlyBanner className="mb-4" />}

      <Tabs value={tab}>
        <TabsContent value="realizacje" className="space-y-6">
          {/* Pasek: miesiąc + akcje */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(-1)}
              title="Poprzedni miesiąc"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-40 text-center text-lg font-semibold">
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(1)}
              title="Następny miesiąc"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {summary && summary.uninvoicedCount > 0 && (
              <span className="ml-2 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700">
                Do zafakturowania: {summary.uninvoicedCount}
              </span>
            )}
            {editable && (
              <div className="ml-auto">
                <Button onClick={() => setFormOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Dodaj realizację
                </Button>
              </div>
            )}
          </div>

          {/* Kafelki podsumowań */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((tile) => (
              <Card
                key={tile.label}
                className={tile.accent ? "border-primary/50" : undefined}
              >
                <CardContent className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {tile.label}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {tile.value}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tile.sub}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Tabela realizacji */}
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak realizacji w tym miesiącu. Kliknij „Dodaj realizację",
                  aby wpisać pierwszą.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Godziny
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Materiały
                        </th>
                        <th className="px-3 py-2 text-right font-medium">KM</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Rabat
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Suma netto
                        </th>
                        <th className="px-3 py-2 font-medium">Adnotacja</th>
                        <th className="px-3 py-2 font-medium">Zafakt.</th>
                        <th className="px-3 py-2 font-medium">Wykonawca</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={row.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => openEdit(row)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(row.date).toLocaleDateString("pl-PL")}
                          </td>
                          <td className="px-3 py-2 font-medium">{row.site}</td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${KIND_META[row.kind]?.badge ?? ""}`}
                            >
                              {KIND_META[row.kind]?.label ?? row.kind}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountHours)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountMaterial)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(row.amountKm)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.discount ? money(row.discount) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(row.total)}
                          </td>
                          <td
                            className="max-w-56 truncate px-3 py-2 text-muted-foreground"
                            title={row.note || undefined}
                          >
                            {row.note || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {row.invoiced ? (
                              <span className="inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                TAK
                              </span>
                            ) : (
                              <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                NIE
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {row.contractor1 || row.caretaker || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {editable && (
                              <div
                                className="flex justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => openEdit(row)}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => handleDelete(row)}
                                  title="Usuń"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Roczna tabela przychód / strata */}
          {summary && (
            <Card className="max-w-xl">
              <CardContent className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Rok {year} — przychód / strata
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Miesiąc</th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Przychód
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Strata
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.months.map((m) => (
                      <tr
                        key={m.month}
                        className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${
                          m.month === month ? "bg-accent/40 font-medium" : ""
                        }`}
                        onClick={() => setMonth(m.month)}
                      >
                        <td className="px-2 py-1.5">
                          {MONTH_NAMES[m.month - 1]}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {money(m.revenue)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {m.loss ? money(m.loss) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="protokoly" className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(-1)}
              title="Poprzedni miesiąc"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-40 text-center text-lg font-semibold">
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => shiftMonth(1)}
              title="Następny miesiąc"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <p className="ml-2 text-sm text-muted-foreground">
              Protokoły tworzą się automatycznie z realizacji.
            </p>
          </div>

          <Card>
            <CardContent className="p-0">
              {protoLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : protocols.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak protokołów w tym miesiącu — dodaj realizację, a protokół
                  powstanie automatycznie.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Numer</th>
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th className="px-3 py-2 font-medium">Wykonawca</th>
                        <th className="px-3 py-2 font-medium">Podpis</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {protocols.map((proto) => (
                        <tr
                          key={proto.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => setEditingProto(proto)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums">
                            {proto.number}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(proto.workDate).toLocaleDateString(
                              "pl-PL"
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {proto.installationAddress || proto.site || "—"}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${PROTOCOL_TYPE_META[proto.workType]?.badge ?? ""}`}
                            >
                              {PROTOCOL_TYPE_META[proto.workType]?.label ??
                                proto.workType}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {proto.contractor || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {proto.signaturePng ? (
                              <span
                                className="font-medium"
                                title={
                                  proto.signedAt
                                    ? `Podpisano ${new Date(proto.signedAt).toLocaleString("pl-PL")}`
                                    : undefined
                                }
                              >
                                {proto.signerName || "podpisano"}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {proto.status === "final" ? (
                              <span className="inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                Zatwierdzony
                              </span>
                            ) : (
                              <span className="inline-flex rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                Szkic
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => printProtocol(proto)}
                                title="Drukuj / PDF"
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                              {editable && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => setEditingProto(proto)}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="wyceny" className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Nowa wycena startuje z pozycjami z cennika — uzupełnij ilości i
              dopisz sprzęt. Rok {year}.
            </p>
            {editable && (
              <Button onClick={handleQuoteNew}>
                <Plus className="h-4 w-4 mr-2" />
                Nowa wycena
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              {quotesLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : quotes.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak wycen. Kliknij „Nowa wycena".
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Numer</th>
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Obiekt</th>
                        <th className="px-3 py-2 font-medium">Adres</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Razem (netto)
                        </th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map((quote) => (
                        <tr
                          key={quote.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => setEditingQuote(quote)}
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums">
                            {quote.number}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {new Date(quote.date).toLocaleDateString("pl-PL")}
                          </td>
                          <td className="px-3 py-2">{quote.site || "—"}</td>
                          <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">
                            {quote.address || "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(quote.total)}
                          </td>
                          <td className="px-3 py-2">
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => printQuote(quote)}
                                title="Drukuj / PDF"
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                              {editable && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => setEditingQuote(quote)}
                                    title="Edytuj"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => handleQuoteDelete(quote)}
                                    title="Usuń"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cennik" className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Cennik usług serwisowych — załącznik do protokołu końcowego.
            </p>
            {editable && (
              <Button onClick={() => setPriceFormOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Dodaj pozycję
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              {priceLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : priceItems.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Cennik jest pusty.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="w-12 px-3 py-2 font-medium">LP.</th>
                        <th className="px-3 py-2 font-medium">
                          Nazwa usługi serwisowej
                        </th>
                        <th className="px-3 py-2 font-medium">J.M.</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Cena sprzedaży (netto)
                        </th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceItems.map((item, idx) => (
                        <tr
                          key={item.id}
                          className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${!item.active ? "opacity-50" : ""}`}
                          onClick={() => {
                            setEditingPrice(item);
                            setPriceFormOpen(true);
                          }}
                        >
                          <td className="px-3 py-2 tabular-nums">{idx + 1}</td>
                          <td className="px-3 py-2 font-medium">
                            {item.name}
                            {!item.active && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                (nieaktywna)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">{item.unit}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(item.price)}
                          </td>
                          <td className="px-3 py-2">
                            {editable && (
                              <div
                                className="flex justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => {
                                    setEditingPrice(item);
                                    setPriceFormOpen(true);
                                  }}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => handlePriceDelete(item)}
                                  title="Usuń"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="technicy" className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Serwisanci podpowiadani w polach „Wykonawca" przy realizacjach.
            </p>
            {editable && (
              <Button onClick={() => setTechFormOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Dodaj technika
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              {techLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : technicians.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak techników. Kliknij „Dodaj technika", aby wpisać
                  pierwszego.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Imię</th>
                        <th className="px-3 py-2 font-medium">Nazwisko</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th className="px-3 py-2 font-medium">Telefon</th>
                        <th className="px-3 py-2 font-medium">Notatka</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {technicians.map((tech) => (
                        <tr
                          key={tech.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => {
                            setEditingTech(tech);
                            setTechFormOpen(true);
                          }}
                        >
                          <td className="px-3 py-2">{tech.firstName || "—"}</td>
                          <td className="px-3 py-2 font-medium">
                            {tech.lastName}
                          </td>
                          <td className="px-3 py-2">
                            {tech.type === "external" ? (
                              <span className="inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
                                Zewnętrzny
                              </span>
                            ) : (
                              <span className="inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                Wewnętrzny
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {tech.phone || "—"}
                          </td>
                          <td
                            className="max-w-72 truncate px-3 py-2 text-muted-foreground"
                            title={tech.notes || undefined}
                          >
                            {tech.notes || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {tech.active ? (
                              <span className="inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                Aktywny
                              </span>
                            ) : (
                              <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                Nieaktywny
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {editable && (
                              <div
                                className="flex justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => {
                                    setEditingTech(tech);
                                    setTechFormOpen(true);
                                  }}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => handleTechDelete(tech)}
                                  title="Usuń"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="obiekty" className="space-y-6">
          <TechnicalObjects />
        </TabsContent>
      </Tabs>

      {priceFormOpen && (
        <PriceItemForm
          key={editingPrice?.id ?? "new"}
          open={priceFormOpen}
          onClose={closePriceForm}
          onSubmit={editingPrice ? handlePriceUpdate : handlePriceCreate}
          item={editingPrice}
        />
      )}

      {editingQuote && (
        <QuoteForm
          key={editingQuote.id}
          open={!!editingQuote}
          onClose={() => setEditingQuote(null)}
          onSubmit={handleQuoteUpdate}
          quote={editingQuote}
        />
      )}

      {editingProto && (
        <ProtocolForm
          key={editingProto.id}
          open={!!editingProto}
          onClose={() => setEditingProto(null)}
          onSubmit={handleProtoUpdate}
          onSign={handleProtoSign}
          onUnsign={handleProtoUnsign}
          protocol={editingProto}
        />
      )}

      {techFormOpen && (
        <TechnicianForm
          key={editingTech?.id ?? "new"}
          open={techFormOpen}
          onClose={closeTechForm}
          onSubmit={editingTech ? handleTechUpdate : handleTechCreate}
          technician={editingTech}
        />
      )}

      {formOpen && (
        <RealizationForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          realization={editing}
          defaultDate={defaultDate}
          technicians={technicians
            .filter((t) => t.active)
            .map((t) => `${t.firstName} ${t.lastName}`.trim())}
        />
      )}
    </div>
  );
}
