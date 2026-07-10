import { useEffect, useState } from "react";
import {
  submitPublicOrderIntake,
  type PublicOrderIntakeInput,
} from "@/lib/api";
import { autoFormatNIP, normalizeNIP, validateNIP } from "@/lib/nip";

const INVOICE_ISSUERS = [
  "ALFA GROUP SP Z O.O.",
  "ALFA GROUP S SP Z O.O.",
] as const;

const LOGO_URL =
  "https://alfagroup.com.pl/wp-content/uploads/2023/07/alfagroup_logo_navbar.png";

interface PublicFormState {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  isCameraInstallation: boolean;
  vtoolsOfferNumber: string;
  payerName: string;
  payerNip: string;
  monthlyAmount: string;
  rentalAmount: string;
  invoiceIssuer: string;
  cameraCount: string;
  megaphoneCount: string;
  objectName: string;
  objectAddress: string;
  objectCity: string;
  objectLocationUrl: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  serviceStartDate: string;
  notes: string;
}

const emptyState: PublicFormState = {
  requesterName: "",
  requesterPhone: "",
  requesterEmail: "",
  isCameraInstallation: false,
  vtoolsOfferNumber: "",
  payerName: "",
  payerNip: "",
  monthlyAmount: "",
  rentalAmount: "",
  invoiceIssuer: INVOICE_ISSUERS[0],
  cameraCount: "",
  megaphoneCount: "",
  objectName: "",
  objectAddress: "",
  objectCity: "",
  objectLocationUrl: "",
  contactPerson: "",
  contactPhone: "",
  contactEmail: "",
  serviceStartDate: "",
  notes: "",
};

const num = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

// Inline styles reproduce the legacy blue Alfa Group form (slesh.pl/ZlecenieAlfa.php).
const fieldLabel: React.CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontWeight: 600,
  fontSize: 14,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
};
const req = <span style={{ color: "#ff6b6b" }}>*</span>;

export function PublicOrderForm() {
  const [form, setForm] = useState<PublicFormState>(emptyState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);

  // Load the Alfa Group brand fonts (Roboto + Roboto Slab) from Google Fonts,
  // matching alfagroup.com.pl. Injected only while this public page is mounted.
  useEffect(() => {
    const id = "alfa-brand-fonts";
    if (document.getElementById(id)) return;
    const preconnectApi = document.createElement("link");
    preconnectApi.rel = "preconnect";
    preconnectApi.href = "https://fonts.googleapis.com";
    const preconnectStatic = document.createElement("link");
    preconnectStatic.rel = "preconnect";
    preconnectStatic.href = "https://fonts.gstatic.com";
    preconnectStatic.crossOrigin = "anonymous";
    const sheet = document.createElement("link");
    sheet.id = id;
    sheet.rel = "stylesheet";
    sheet.href =
      "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Slab:wght@500;600;700&display=swap";
    document.head.append(preconnectApi, preconnectStatic, sheet);
  }, []);

  const set = <K extends keyof PublicFormState>(
    key: K,
    value: PublicFormState[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleInput =
    (key: keyof PublicFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value as PublicFormState[typeof key]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateNIP(form.payerNip)) {
      setError("Podaj prawidłowy NIP płatnika (10 cyfr).");
      return;
    }

    const payload: PublicOrderIntakeInput = {
      requesterName: form.requesterName,
      requesterPhone: form.requesterPhone,
      requesterEmail: form.requesterEmail,
      isCameraInstallation: form.isCameraInstallation,
      vtoolsOfferNumber: form.isCameraInstallation
        ? form.vtoolsOfferNumber || undefined
        : undefined,
      payerName: form.payerName,
      payerNip: normalizeNIP(form.payerNip),
      monthlyAmount: num(form.monthlyAmount),
      rentalAmount: num(form.rentalAmount),
      invoiceIssuer: form.invoiceIssuer || undefined,
      cameraCount: num(form.cameraCount),
      megaphoneCount: num(form.megaphoneCount),
      objectName: form.objectName,
      objectAddress: form.objectAddress || undefined,
      objectCity: form.objectCity,
      objectLocationUrl: form.objectLocationUrl || undefined,
      contactPerson: form.contactPerson,
      contactPhone: form.contactPhone,
      contactEmail: form.contactEmail || undefined,
      serviceStartDate: form.serviceStartDate || undefined,
      notes: form.notes || undefined,
    };

    setLoading(true);
    try {
      const res = await submitPublicOrderIntake(payload);
      setOrderNumber(res.data?.orderNumber ?? "");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Wystąpił błąd podczas wysyłania zlecenia. Spróbuj ponownie."
      );
    } finally {
      setLoading(false);
    }
  };

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    backgroundColor: "#072c61",
    color: "#ffffff",
    padding: "24px 16px",
    fontFamily:
      "'Roboto', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  };

  const containerStyle: React.CSSProperties = {
    maxWidth: 760,
    margin: "0 auto",
  };

  if (orderNumber !== null) {
    return (
      <div style={pageStyle}>
        <div style={containerStyle}>
          <img
            src={LOGO_URL}
            alt="Alfa Group"
            style={{ height: 40, marginBottom: 32 }}
          />
          <div
            style={{
              backgroundColor: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 10,
              padding: "40px 24px",
              textAlign: "center",
            }}
          >
            <h1
              style={{
                fontFamily: "'Roboto Slab', Georgia, serif",
                fontSize: 24,
                margin: "0 0 12px",
              }}
            >
              Dziękujemy — zlecenie zostało przyjęte.
            </h1>
            <p style={{ fontSize: 18, margin: 0 }}>
              Numer: <strong>{orderNumber}</strong>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
            marginBottom: 8,
          }}
        >
          <img src={LOGO_URL} alt="Alfa Group" style={{ height: 40 }} />
          <h1
            style={{
              fontFamily: "'Roboto Slab', Georgia, serif",
              fontSize: 26,
              fontWeight: 700,
              margin: 0,
              textAlign: "right",
            }}
          >
            Zlecenie Zdalnego Dozoru Wideo
          </h1>
        </div>
        <p
          style={{
            margin: "0 0 24px",
            color: "#cbd5e1",
            fontSize: 14,
            textAlign: "right",
          }}
        >
          Pola oznaczone {req} są wymagane.
        </p>

        {error && (
          <div
            style={{
              backgroundColor: "#7f1d1d",
              border: "1px solid #ef4444",
              borderRadius: 6,
              padding: "12px 14px",
              marginBottom: 20,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 18 }}
        >
          {/* Osoba zlecająca */}
          <div>
            <label style={fieldLabel}>Osoba zlecająca {req}</label>
            <input
              style={inputStyle}
              value={form.requesterName}
              onChange={handleInput("requesterName")}
              required
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Telefon {req}</label>
              <input
                style={inputStyle}
                type="tel"
                value={form.requesterPhone}
                onChange={handleInput("requesterPhone")}
                required
              />
            </div>
            <div>
              <label style={fieldLabel}>Email {req}</label>
              <input
                style={inputStyle}
                type="email"
                value={form.requesterEmail}
                onChange={handleInput("requesterEmail")}
                required
              />
            </div>
          </div>

          {/* Montaż kamer */}
          <div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={form.isCameraInstallation}
                onChange={(e) => set("isCameraInstallation", e.target.checked)}
              />
              Czy montaż kamer?
            </label>
          </div>
          {form.isCameraInstallation && (
            <div>
              <label style={fieldLabel}>Nr oferty Vtools</label>
              <input
                style={inputStyle}
                value={form.vtoolsOfferNumber}
                onChange={handleInput("vtoolsOfferNumber")}
              />
            </div>
          )}

          {/* Płatnik */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Nazwa płatnika {req}</label>
              <input
                style={inputStyle}
                value={form.payerName}
                onChange={handleInput("payerName")}
                required
              />
            </div>
            <div>
              <label style={fieldLabel}>NIP Płatnika {req}</label>
              <input
                style={inputStyle}
                value={autoFormatNIP(form.payerNip)}
                onChange={(e) => set("payerNip", normalizeNIP(e.target.value))}
                placeholder="123-456-78-90"
                maxLength={13}
                required
              />
            </div>
          </div>

          {/* Finanse */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Ustalona kwota abonamentu</label>
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="0"
                value={form.monthlyAmount}
                onChange={handleInput("monthlyAmount")}
              />
            </div>
            <div>
              <label style={fieldLabel}>Kwota dzierżawy</label>
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="0"
                value={form.rentalAmount}
                onChange={handleInput("rentalAmount")}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabel}>Faktury wystawia</label>
            <select
              style={inputStyle}
              value={form.invoiceIssuer}
              onChange={(e) => set("invoiceIssuer", e.target.value)}
            >
              {INVOICE_ISSUERS.map((issuer) => (
                <option key={issuer} value={issuer}>
                  {issuer}
                </option>
              ))}
            </select>
          </div>

          {/* Sprzęt */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Ilość kamer</label>
              <input
                style={inputStyle}
                type="number"
                min="0"
                value={form.cameraCount}
                onChange={handleInput("cameraCount")}
              />
            </div>
            <div>
              <label style={fieldLabel}>Ilość megafonów</label>
              <input
                style={inputStyle}
                type="number"
                min="0"
                value={form.megaphoneCount}
                onChange={handleInput("megaphoneCount")}
              />
            </div>
          </div>

          {/* Obiekt */}
          <div>
            <label style={fieldLabel}>Nazwa obiektu w SAFESTAR {req}</label>
            <input
              style={inputStyle}
              value={form.objectName}
              onChange={handleInput("objectName")}
              required
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Adres obiektu {req}</label>
              <input
                style={inputStyle}
                value={form.objectAddress}
                onChange={handleInput("objectAddress")}
                required
              />
            </div>
            <div>
              <label style={fieldLabel}>Miejscowość {req}</label>
              <input
                style={inputStyle}
                value={form.objectCity}
                onChange={handleInput("objectCity")}
                required
              />
            </div>
          </div>
          <div>
            <label style={fieldLabel}>Lokalizacja Google</label>
            <input
              style={inputStyle}
              type="url"
              value={form.objectLocationUrl}
              onChange={handleInput("objectLocationUrl")}
              placeholder="https://maps.google.com/..."
            />
          </div>

          {/* Osoba kontaktowa */}
          <div>
            <label style={fieldLabel}>Osoba kontaktowa {req}</label>
            <input
              style={inputStyle}
              value={form.contactPerson}
              onChange={handleInput("contactPerson")}
              required
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={fieldLabel}>Telefon {req}</label>
              <input
                style={inputStyle}
                type="tel"
                value={form.contactPhone}
                onChange={handleInput("contactPhone")}
                required
              />
            </div>
            <div>
              <label style={fieldLabel}>Adres mailowy</label>
              <input
                style={inputStyle}
                type="email"
                value={form.contactEmail}
                onChange={handleInput("contactEmail")}
              />
            </div>
          </div>

          {/* Termin + uwagi */}
          <div>
            <label style={fieldLabel}>Początek usługi</label>
            <input
              style={inputStyle}
              type="date"
              value={form.serviceStartDate}
              onChange={handleInput("serviceStartDate")}
            />
          </div>
          <div>
            <label style={fieldLabel}>UWAGI</label>
            <textarea
              style={{ ...inputStyle, minHeight: 96, resize: "vertical" }}
              value={form.notes}
              onChange={handleInput("notes")}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              backgroundColor: "#28a745",
              color: "#ffffff",
              border: "none",
              borderRadius: 6,
              padding: "12px 20px",
              fontSize: 16,
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.7 : 1,
              alignSelf: "flex-start",
            }}
          >
            {loading ? "Wysyłanie..." : "Wyślij zlecenie"}
          </button>
        </form>
      </div>
    </div>
  );
}
