import { useState, useCallback, useEffect } from "react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { Check, AlertCircle, Loader2, Building2 } from "lucide-react";
import { autoFormatNIP, validateNIP, normalizeNIP, type NIPValidationStatus } from "@/lib/nip";
import { checkContractorByNIP, type Contractor } from "@/lib/api";

interface NIPFieldProps {
  value: string;
  onChange: (value: string, contractor: Contractor | null) => void;
  onUseExisting?: (contractor: Contractor) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
}

export function NIPField({
  value,
  onChange,
  onUseExisting,
  label = "NIP",
  required = true,
  disabled = false,
}: NIPFieldProps) {
  const [status, setStatus] = useState<NIPValidationStatus>("empty");
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkNIP = useCallback(async (nip: string) => {
    const normalized = normalizeNIP(nip);
    
    if (normalized.length === 0) {
      setStatus("empty");
      setContractor(null);
      setError(null);
      onChange("", null);
      return;
    }
    
    if (normalized.length < 10 || !validateNIP(normalized)) {
      setStatus("invalid");
      setContractor(null);
      setError("Nieprawidłowy format NIP");
      onChange(normalized, null);
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
        onChange(normalized, contractorData);
      } else {
        setStatus("available");
        setContractor(null);
        onChange(normalized, null);
      }
    } catch (err) {
      setStatus("error");
      setError("Błąd sprawdzania NIP");
      onChange(normalized, null);
    }
  }, [onChange]);

  // Debounced check
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value) {
        checkNIP(value);
      }
    }, 300);
    
    return () => clearTimeout(timer);
  }, [value, checkNIP]);

  const handleUseExisting = () => {
    if (contractor && onUseExisting) {
      onUseExisting(contractor);
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case "checking":
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case "exists":
        return <Check className="h-4 w-4 text-green-500" />;
      case "invalid":
      case "error":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "checking":
        return "Sprawdzam...";
      case "exists":
        return "Kontrahent o tym NIP już istnieje";
      case "available":
        return "Można utworzyć nowego kontrahenta";
      case "invalid":
        return error;
      case "error":
        return "Błąd sprawdzania";
      default:
        return null;
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="nip">
        {label} {required && <span className="text-red-500">*</span>}
      </Label>
      <div className="relative">
        <Input
          id="nip"
          value={autoFormatNIP(value)}
          onChange={(e) => {
            const normalized = normalizeNIP(e.target.value);
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
    </div>
  );
}
