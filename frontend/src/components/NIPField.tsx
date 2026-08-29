import { useState, useCallback, useEffect, useRef } from "react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Check,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Building2,
  Search,
  RefreshCw,
} from "lucide-react";
import { autoFormatNIP, validateNIP, normalizeNIP, type NIPValidationStatus } from "@/lib/nip";
import {
  checkContractorByNIP,
  lookupCompanyByNip,
  type CompanyData,
  type Contractor,
} from "@/lib/api";

interface NIPFieldProps {
  value: string;
  onChange: (value: string, contractor: Contractor | null) => void;
  onUseExisting?: (contractor: Contractor) => void;
  /** Wywoływane po „Wstaw dane” — formularz sam decyduje, które pola uzupełnić. */
  onCompanyFound?: (company: CompanyData) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  /** Sprawdzać, czy kontrahent o tym NIP jest już w bazie (wymaga dostępu do modułu kontrahentów). */
  checkExisting?: boolean;
  /** Oferować pobranie danych z wykazu VAT MF. */
  lookupRegistry?: boolean;
  /** Pobierać z MF automatycznie po wpisaniu poprawnego NIP-u (bez klikania). */
  autoLookup?: boolean;
  /** Unikalne id pola — gdy w jednym formularzu jest więcej niż jeden NIP. */
  id?: string;
}

/** Kolor plakietki statusu VAT: czynny = OK, zwolniony = do sprawdzenia, brak = ostrzeżenie. */
function vatVariant(status: CompanyData["statusVat"]): "success" | "warning" | "destructive" {
  if (status === "Czynny") return "success";
  if (status === "Zwolniony") return "warning";
  return "destructive";
}

export function NIPField({
  value,
  onChange,
  onUseExisting,
  onCompanyFound,
  label = "NIP",
  required = true,
  disabled = false,
  checkExisting = true,
  lookupRegistry = true,
  autoLookup = true,
  id = "nip",
}: NIPFieldProps) {
  const [status, setStatus] = useState<NIPValidationStatus>("empty");
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<CompanyData | null>(null);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [notInRegistry, setNotInRegistry] = useState(false);

  // Ostatni NIP pobrany z MF — chroni przed powtarzaniem zapytania przy każdym renderze.
  const lookedUpRef = useRef<string>("");

  const resetRegistry = useCallback(() => {
    setCompany(null);
    setCompanyError(null);
    setNotInRegistry(false);
    lookedUpRef.current = "";
  }, []);

  /** Pobiera dane firmy z wykazu MF. `refresh` pomija cache po stronie serwera. */
  const fetchCompany = useCallback(
    async (nip: string, refresh = false) => {
      const normalized = normalizeNIP(nip);
      if (!validateNIP(normalized)) return;
      if (!refresh && lookedUpRef.current === normalized) return;

      lookedUpRef.current = normalized;
      setCompanyLoading(true);
      setCompanyError(null);
      setNotInRegistry(false);
      try {
        const res = await lookupCompanyByNip(normalized, refresh);
        if (res.data?.found && res.data.company) {
          setCompany(res.data.company);
        } else {
          setCompany(null);
          setNotInRegistry(true);
        }
      } catch (err) {
        // Awaria rejestru nie może blokować formularza — pokazujemy ostrzeżenie,
        // dane zawsze można wpisać ręcznie.
        setCompany(null);
        setCompanyError(
          err instanceof Error ? err.message : "Nie udało się pobrać danych z wykazu MF"
        );
        lookedUpRef.current = "";
      } finally {
        setCompanyLoading(false);
      }
    },
    []
  );

  const checkNIP = useCallback(
    async (nip: string) => {
      const normalized = normalizeNIP(nip);

      if (normalized.length === 0) {
        setStatus("empty");
        setContractor(null);
        setError(null);
        resetRegistry();
        onChange("", null);
        return;
      }

      if (normalized.length < 10 || !validateNIP(normalized)) {
        setStatus("invalid");
        setContractor(null);
        setError("Nieprawidłowy format NIP");
        resetRegistry();
        onChange(normalized, null);
        return;
      }

      if (!checkExisting) {
        // Bez sprawdzania bazy NIP jest po prostu poprawny; dane firmy z rejestru.
        setStatus("available");
        setContractor(null);
        setError(null);
        onChange(normalized, null);
        if (lookupRegistry && autoLookup) void fetchCompany(normalized);
        return;
      }

      setStatus("checking");
      setError(null);

      try {
        const response = await checkContractorByNIP(normalized);

        if (response.data?.exists && response.data) {
          const contractorData = response.data as unknown as Contractor;
          setStatus("exists");
          setContractor(contractorData);
          // Kontrahent jest już w bazie — nie zawracamy głowy rejestrem.
          resetRegistry();
          onChange(normalized, contractorData);
        } else {
          setStatus("available");
          setContractor(null);
          onChange(normalized, null);
          if (lookupRegistry && autoLookup) void fetchCompany(normalized);
        }
      } catch (err) {
        setStatus("error");
        setError("Błąd sprawdzania NIP");
        onChange(normalized, null);
      }
    },
    [onChange, checkExisting, lookupRegistry, autoLookup, fetchCompany, resetRegistry]
  );

  // Debounced check
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value) {
        checkNIP(value);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [value, checkNIP]);

  const handleUseExisting = () => {
    if (contractor && onUseExisting) {
      onUseExisting(contractor);
    }
  };

  const getStatusIcon = () => {
    if (companyLoading) {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    }
    switch (status) {
      case "checking":
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case "exists":
        return <Check className="h-4 w-4 text-green-500" />;
      case "invalid":
      case "error":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case "available":
        return <Check className="h-4 w-4 text-slate-400" />;
      default:
        return null;
    }
  };

  const getStatusText = () => {
    if (companyLoading) return "Szukam firmy w wykazie MF…";
    switch (status) {
      case "checking":
        return "Sprawdzam…";
      case "exists":
        return "Kontrahent o tym NIP już istnieje";
      case "available":
        return checkExisting ? "Można utworzyć nowego kontrahenta" : "NIP poprawny";
      case "invalid":
        return error;
      case "error":
        return "Błąd sprawdzania";
      default:
        return null;
    }
  };

  const nipValid = validateNIP(normalizeNIP(value));
  const canLookup = lookupRegistry && nipValid && !disabled && status !== "exists";

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <span className="text-red-500">*</span>}
      </Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            value={autoFormatNIP(value)}
            onChange={(e) => {
              const normalized = normalizeNIP(e.target.value);
              resetRegistry();
              onChange(normalized, null);
            }}
            placeholder="123-456-78-90"
            maxLength={13}
            disabled={disabled}
            className={`pr-10 ${
              status === "invalid" || status === "error"
                ? "border-red-500 focus-visible:ring-red-500"
                : status === "exists"
                ? "border-green-500 focus-visible:ring-green-500"
                : ""
            }`}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {getStatusIcon()}
          </div>
        </div>
        {canLookup && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 shrink-0"
            disabled={companyLoading}
            onClick={() => fetchCompany(value, true)}
            title="Pobierz nazwę i adres z wykazu podatników VAT (Ministerstwo Finansów)"
          >
            {companyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : company ? (
              <RefreshCw className="h-4 w-4" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            <span className="ml-2 hidden sm:inline">
              {company ? "Odśwież" : "Szukaj firmy"}
            </span>
          </Button>
        )}
      </div>

      {getStatusText() && (
        <p
          className={`text-sm ${
            status === "invalid" || status === "error"
              ? "text-red-500"
              : status === "exists"
              ? "text-green-600"
              : "text-muted-foreground"
          }`}
        >
          {getStatusText()}
        </p>
      )}

      {status === "exists" && contractor && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-start gap-3">
            <Building2 className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-green-900">{contractor.name}</p>
              <p className="text-sm text-green-700">
                NIP: {contractor.nip}
                {contractor.city && ` • ${contractor.city}`}
              </p>
            </div>
            {onUseExisting && (
              <Button
                type="button"
                size="sm"
                onClick={handleUseExisting}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                Użyj tego
              </Button>
            )}
          </div>
        </div>
      )}

      {company && status !== "exists" && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
          <div className="flex items-start gap-3">
            <Building2 className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-blue-900 break-words">{company.name}</p>
              <p className="text-sm text-blue-700">
                {[company.address, [company.postalCode, company.city].filter(Boolean).join(" ")]
                  .filter(Boolean)
                  .join(", ") || company.rawAddress}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={vatVariant(company.statusVat)}>
                  VAT: {company.statusVat ?? "brak danych"}
                </Badge>
                {company.regon && (
                  <span className="text-xs text-blue-700">REGON {company.regon}</span>
                )}
                {company.krs && (
                  <span className="text-xs text-blue-700">KRS {company.krs}</span>
                )}
              </div>
            </div>
            {onCompanyFound && (
              <Button
                type="button"
                size="sm"
                onClick={() => onCompanyFound(company)}
                className="bg-blue-600 hover:bg-blue-700 text-white shrink-0"
              >
                Wstaw dane
              </Button>
            )}
          </div>
          <p className="text-[11px] text-blue-600/80">
            Źródło: wykaz podatników VAT MF, stan na {company.date}
          </p>
        </div>
      )}

      {notInRegistry && status !== "exists" && (
        <p className="flex items-center gap-2 text-sm text-amber-600">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Nie znaleziono firmy o tym NIP w wykazie VAT — wpisz dane ręcznie.
        </p>
      )}

      {companyError && (
        <p className="flex items-center gap-2 text-sm text-amber-600">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {companyError}
        </p>
      )}
    </div>
  );
}
