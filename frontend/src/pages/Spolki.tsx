import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CompanyForm } from "@/components/CompanyForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Archive,
  ArchiveRestore,
  Building2,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  lookupCompanyInMf,
  type Company,
  type CompanyInput,
} from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

/**
 * Spółki grupy — słownik wspólny z kadrami. Nazwy pochodzą z arkusza WYNAGRODZENIA
 * (`hr_contracts.company`), więc kolumna „Umowy” pokazuje, ile umów kadrowych wisi
 * na danej spółce, a „Obiekty” — ile obiektów jest do niej przypisanych.
 */
export function Spolki() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("spolki");

  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  /** Id spółki, dla której trwa sprawdzenie w wykazie MF. */
  const [checking, setChecking] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getCompanies();
      setRows(res.data ?? []);
    } catch (error) {
      console.error("Error loading companies:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const matches = (c: Company) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.fullName, c.nip, c.notes]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };

  const visible = rows.filter(matches);
  const active = visible.filter((c) => c.active);
  const archived = visible.filter((c) => !c.active);

  const handleCreate = async (data: CompanyInput) => {
    await createCompany(data);
    load();
  };

  const handleUpdate = async (data: CompanyInput) => {
    if (!editing) return;
    await updateCompany(editing.id, data);
    load();
  };

  const toggleArchive = async (c: Company) => {
    if (!editable) return;
    try {
      await updateCompany(c.id, { active: !c.active });
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się zmienić statusu");
    }
  };

  const handleDelete = async (c: Company) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć spółkę ${c.name}?`)) return;
    try {
      await deleteCompany(c.id);
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć spółki");
    }
  };

  /** Sprawdzenie w wykazie VAT MF po NIP-ie spółki (nasz walidator) + zapis danych. */
  const checkInMf = async (c: Company) => {
    if (!editable) return;
    if (!c.nip) {
      alert("Spółka nie ma NIP-u — uzupełnij go w edycji, wtedy pobiorę dane z wykazu MF.");
      return;
    }
    setChecking(c.id);
    try {
      const res = await lookupCompanyInMf(c.id);
      await load();
      if (res.message) alert(res.message);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się sprawdzić w wykazie MF");
    } finally {
      setChecking(null);
    }
  };

  const openEdit = (c: Company) => {
    setEditing(c);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const totals = (list: Company[]) => ({
    objects: list.reduce((a, c) => a + (c.objectsCount ?? 0), 0),
    value: list.reduce((a, c) => a + (c.objectsMonthlyValue ?? 0), 0),
    contracts: list.reduce((a, c) => a + (c.contractsCount ?? 0), 0),
  });

  const renderTable = (list: Company[], emptyText: string) => {
    if (loading) return <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>;
    if (list.length === 0) {
      return <div className="py-10 text-center text-muted-foreground">{emptyText}</div>;
    }
    const sum = totals(list);
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="text-left py-3 px-2 font-medium">Spółka</th>
              <th className="text-left py-3 px-2 font-medium">Pełna nazwa</th>
              <th className="text-left py-3 px-2 font-medium">NIP</th>
              <th className="text-left py-3 px-2 font-medium">VAT (wykaz MF)</th>
              <th className="text-right py-3 px-2 font-medium">Obiekty</th>
              <th className="text-right py-3 px-2 font-medium">Abonament</th>
              <th
                className="text-right py-3 px-2 font-medium"
                title="Umowy w module Kadry → Wynagrodzenia wskazujące na tę spółkę"
              >
                Umowy (kadry)
              </th>
              <th className="text-right py-3 px-2 font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="border-b hover:bg-muted/50">
                <td className="py-3 px-2 font-medium">
                  {c.name}
                  {c.notes && (
                    <span className="block text-xs text-muted-foreground">{c.notes}</span>
                  )}
                </td>
                <td className="py-3 px-2">{c.fullName || "-"}</td>
                <td className="py-3 px-2 tabular-nums">{c.nip || "-"}</td>
                <td className="py-3 px-2">
                  {c.vatStatus ? (
                    <span className="flex flex-col gap-0.5">
                      {/* „Niezarejestrowany” = podmiot nie figuruje w wykazie VAT. Dla spółek
                          komandytowych grupy to normalne (nie są podatnikami VAT), więc
                          pokazujemy to spokojnym kolorem, a nie alarmem. */}
                      <Badge
                        variant={
                          c.vatStatus === "Czynny"
                            ? "success"
                            : c.vatStatus === "Zwolniony"
                              ? "warning"
                              : "secondary"
                        }
                        className="w-fit"
                        title={
                          c.vatStatus === "Niezarejestrowany"
                            ? "Nie figuruje w wykazie podatników VAT (biała lista MF)"
                            : undefined
                        }
                      >
                        {c.vatStatus === "Niezarejestrowany" ? "Brak w wykazie VAT" : c.vatStatus}
                      </Badge>
                      {c.vatCheckedAt && (
                        <span className="text-xs text-muted-foreground">{c.vatCheckedAt}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {c.nip ? "niesprawdzona" : "brak NIP-u"}
                    </span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.objectsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/objects?companyId=${c.id}`)}
                      title="Pokaż obiekty tej spółki"
                    >
                      {c.objectsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.objectsMonthlyValue ? formatCurrency(c.objectsMonthlyValue) : "-"}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.contractsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate("/kadry/wynagrodzenia")}
                      title="Przejdź do wynagrodzeń"
                    >
                      {c.contractsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/objects?companyId=${c.id}`)}
                      title="Obiekty spółki"
                    >
                      <Building2 className="h-4 w-4" />
                    </Button>
                    {editable && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => checkInMf(c)}
                          disabled={checking === c.id}
                          title={
                            c.nip
                              ? "Sprawdź w wykazie VAT MF i uzupełnij dane"
                              : "Brak NIP-u — uzupełnij go w edycji"
                          }
                          data-testid={`company-mf-${c.id}`}
                        >
                          {checking === c.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(c)}
                          title="Edytuj"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleArchive(c)}
                          title={c.active ? "Przenieś do archiwum" : "Przywróć"}
                          data-testid={`company-archive-${c.id}`}
                        >
                          {c.active ? (
                            <Archive className="h-4 w-4" />
                          ) : (
                            <ArchiveRestore className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(c)}
                          title="Usuń"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t">
              <td className="py-3 px-2 font-medium" colSpan={4}>
                Razem
              </td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">{sum.objects}</td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">
                {formatCurrency(sum.value)}
              </td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">{sum.contracts}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj spółki..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Ten sam słownik, co spółki w Kadrach → Wynagrodzenia
        </p>
        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowa spółka
          </Button>
        )}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active">Aktualne ({active.length})</TabsTrigger>
          <TabsTrigger value="archived">Archiwalne ({archived.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(active, "Brak spółek. Kliknij „Nowa spółka”, aby dodać pierwszą.")}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="archived" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(archived, "Brak archiwalnych spółek.")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {formOpen && (
        <CompanyForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          company={editing}
        />
      )}
    </div>
  );
}
