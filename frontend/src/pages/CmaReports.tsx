import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  Cctv,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cmaApi, type CmaReport } from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

function formatCmaDateTime(value: string | null): string {
  // Backend dates come as "YYYY-MM-DD HH:MM:SS".
  if (!value || value.length < 10) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  const time = value.slice(11, 16);
  return `${d}.${m}.${y}${time ? ` ${time}` : ""}`;
}

export function CmaReports() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("cma/raporty");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [reports, setReports] = useState<CmaReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const response = await cmaApi.getReports({ page });
      setReports(response.data);
      setTotalPages(response.totalPages);
    } catch (error) {
      console.error("Error fetching CMA reports:", error);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!editable) return;
    const file = event.target.files?.[0];
    // Allow re-selecting the same file next time.
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportError(null);
    try {
      const response = await cmaApi.importReport(file);
      await fetchReports();
      if (response.data) {
        navigate(`/cma/raporty/${response.data.id}`);
      }
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "Nie udało się zaimportować raportu"
      );
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (report: CmaReport) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Czy na pewno chcesz usunąć raport "${report.title}"? Tej operacji nie można cofnąć.`
      )
    ) {
      return;
    }
    try {
      await cmaApi.deleteReport(report.id);
      fetchReports();
    } catch (error) {
      console.error("Error deleting CMA report:", error);
    }
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <input
        ref={fileInputRef}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Import error */}
      {importError && (
        <Alert variant="destructive" className="border-red-300 bg-red-50">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Błąd importu</AlertTitle>
          <AlertDescription className="flex items-start justify-between gap-4">
            <span>{importError}</span>
            <button
              onClick={() => setImportError(null)}
              className="shrink-0 text-red-600 hover:text-red-800"
              title="Zamknij"
            >
              <X className="w-4 h-4" />
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* Reports list */}
      {loading ? (
        <div className="text-center py-16 text-slate-500">Ładowanie...</div>
      ) : reports.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 py-16 text-center">
          <Cctv className="w-12 h-12 mx-auto text-slate-300" />
          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            Brak zaimportowanych raportów
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Zaimportuj plik .xls lub .xlsx z raportem z przeglądu kamer, aby
            zobaczyć zestawienie zdarzeń.
          </p>
          {editable && (
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              variant="outline"
              className="mt-4"
            >
              <Upload className="w-4 h-4 mr-2" />
              Importuj pierwszy raport
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {editable && (
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
              <span className="text-sm text-slate-500">
                {reports.length} {reports.length === 1 ? "raport" : "raportów"}
              </span>
              <Button
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {importing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importowanie...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Importuj raport
                  </>
                )}
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="font-semibold">Raport</TableHead>
                <TableHead className="font-semibold">Zakres dat</TableHead>
                <TableHead className="font-semibold text-right">
                  Zdarzenia
                </TableHead>
                <TableHead className="font-semibold">Zaimportowano</TableHead>
                {editable && (
                  <TableHead className="font-semibold text-right">
                    Akcje
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow
                  key={report.id}
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => navigate(`/cma/raporty/${report.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <FileSpreadsheet className="w-5 h-5 shrink-0 text-emerald-600" />
                      <div>
                        <div className="font-medium text-slate-900">
                          {report.title}
                        </div>
                        <div className="text-xs text-slate-500">
                          {report.fileName}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-slate-700 whitespace-nowrap">
                    {formatCmaDateTime(report.dateFrom)}
                    {" – "}
                    {formatCmaDateTime(report.dateTo)}
                  </TableCell>
                  <TableCell className="text-right font-medium text-slate-900">
                    {report.entryCount.toLocaleString("pl-PL")}
                  </TableCell>
                  <TableCell className="text-sm text-slate-500 whitespace-nowrap">
                    {formatCmaDateTime(report.importedAt)}
                  </TableCell>
                  {editable && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(report);
                        }}
                        className="text-slate-600 hover:text-red-600"
                        title="Usuń raport"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-200 p-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Poprzednia
              </Button>
              <span className="text-sm text-slate-500">
                Strona {page} z {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Następna
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
