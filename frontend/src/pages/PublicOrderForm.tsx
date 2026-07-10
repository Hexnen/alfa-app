import { useState } from "react";
import {
  submitPublicOrderIntake,
  type PublicOrderIntakeInput,
} from "@/lib/api";
import { autoFormatNIP, normalizeNIP, validateNIP } from "@/lib/nip";
import {
  INVOICE_ISSUERS,
  OBJECT_KINDS,
  useOrderIntakeDraft,
  useOrderIntakeWizard,
  type OrderIntakeFormState,
} from "@/lib/orderIntakeSteps";
import { LocationPicker } from "@/components/LocationPicker";
import "./PublicOrderForm.css";

const LOGO_URL =
  "https://alfagroup.com.pl/wp-content/uploads/2023/07/alfagroup_logo_navbar.png";

const num = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

const req = <span className="zdw-req">*</span>;


/** Yes/no segmented toggle, blue-theme flavour. */
function YesNoToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="zdw-seg">
      <button
        type="button"
        className={`zdw-seg-btn${value ? " on" : ""}`}
        onClick={() => onChange(true)}
      >
        Tak
      </button>
      <button
        type="button"
        className={`zdw-seg-btn${!value ? " on" : ""}`}
        onClick={() => onChange(false)}
      >
        Nie
      </button>
    </div>
  );
}

export function PublicOrderForm() {
  const [form, setForm, clearDraft] = useOrderIntakeDraft("zdwPublicOrderDraft");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);

  const wizard = useOrderIntakeWizard(form);

  const set = <K extends keyof OrderIntakeFormState>(
    key: K,
    value: OrderIntakeFormState[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleInput =
    (key: keyof OrderIntakeFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value as OrderIntakeFormState[typeof key]);

  const scrollToTop = () =>
    window.scrollTo({ top: 0, behavior: "smooth" });

  const handleNext = () => {
    const result = wizard.validateCurrent();
    if (!result.ok) {
      setError(result.message ?? "Uzupełnij wymagane pola.");
      return;
    }
    setError(null);
    wizard.next();
    scrollToTop();
  };

  const handleBack = () => {
    setError(null);
    wizard.back();
    scrollToTop();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Before the last step, submitting (e.g. via Enter) advances the wizard.
    if (!wizard.isLast) {
      handleNext();
      return;
    }

    const result = wizard.validateCurrent();
    if (!result.ok) {
      setError(result.message ?? "Uzupełnij wymagane pola.");
      return;
    }
    if (!validateNIP(form.payerNip)) {
      setError("Podaj prawidłowy NIP płatnika (10 cyfr).");
      return;
    }
    setError(null);

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
      payerInvoiceEmail: form.payerInvoiceEmail || undefined,
      monthlyAmount: num(form.monthlyAmount),
      contractLengthMonths: num(form.contractLengthMonths),
      rentalAmount: num(form.rentalAmount),
      rentalLengthMonths: num(form.rentalLengthMonths),
      invoiceIssuer: form.invoiceIssuer || undefined,
      cameraCount: num(form.cameraCount),
      megaphoneCount: num(form.megaphoneCount),
      objectName: form.objectName,
      objectKind: form.objectKind || undefined,
      objectAddress: form.objectAddress || undefined,
      objectCity: form.objectCity,
      objectLocationUrl: form.objectLocationUrl || undefined,
      contactPerson: form.contactPerson,
      contactPhone: form.contactPhone,
      contactEmail: form.contactEmail || undefined,
      serviceStartDate: form.serviceStartDate || undefined,
      notes: form.notes || undefined,
      internetIncluded: form.internetIncluded,
      interventionGroup: form.interventionGroup,
      videoReception: form.videoReception,
      installationStartDate: form.isCameraInstallation
        ? form.installationStartDate || undefined
        : undefined,
    };

    setLoading(true);
    try {
      const res = await submitPublicOrderIntake(payload);
      clearDraft();
      setOrderNumber(res.data?.orderNumber ?? "");
      scrollToTop();
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

  if (orderNumber !== null) {
    return (
      <div className="zdw-page">
        <div className="zdw-wrap">
          <div className="zdw-header">
            <img className="zdw-logo" src={LOGO_URL} alt="Alfa Group" />
          </div>
          <div className="zdw-card zdw-done">
            <div className="zdw-done-ring">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none">
                <path
                  className="zdw-check"
                  d="M5 13l4 4L19 7"
                  stroke="#4ade80"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h1>Dziękujemy — zlecenie zostało przyjęte.</h1>
            <p>
              Numer: <strong>{orderNumber}</strong>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { currentStep, stepIndex, totalSteps, isFirst, isLast } = wizard;
  const progress = ((stepIndex + 1) / totalSteps) * 100;

  return (
    <div className="zdw-page">
      <div className="zdw-wrap">
        {/* Header: logo + Roboto Slab title */}
        <div className="zdw-header">
          <img className="zdw-logo" src={LOGO_URL} alt="Alfa Group" />
          <div className="zdw-titlewrap">
            <h1 className="zdw-title">Zlecenie Zdalnego Dozoru Wideo</h1>
            <p className="zdw-sub">Pola oznaczone {req} są wymagane.</p>
          </div>
        </div>

        <div className="zdw-card">
          {/* Step indicator */}
          <div style={{ marginBottom: 22 }}>
            <div className="zdw-prog-head">
              <span className="zdw-kicker">
                Krok {stepIndex + 1} z {totalSteps}
              </span>
              <span className="zdw-step-title">{currentStep.title}</span>
            </div>
            <div className="zdw-track">
              <div className="zdw-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>

          {error && (
            <div className="zdw-error" style={{ marginBottom: 20 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="zdw-form">
            {/* Animated step body — key re-triggers the enter animation */}
            <div key={currentStep.id} className="zdw-step zdw-form">
              {/* Step 1: Osoba zlecająca */}
              {currentStep.id === "requester" && (
                <>
                  <div>
                    <label className="zdw-label">Osoba zlecająca {req}</label>
                    <input
                      className="zdw-input"
                      value={form.requesterName}
                      onChange={handleInput("requesterName")}
                    />
                  </div>
                  <div className="zdw-grid2">
                    <div>
                      <label className="zdw-label">Telefon {req}</label>
                      <input
                        className="zdw-input"
                        type="tel"
                        value={form.requesterPhone}
                        onChange={handleInput("requesterPhone")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Email {req}</label>
                      <input
                        className="zdw-input"
                        type="email"
                        value={form.requesterEmail}
                        onChange={handleInput("requesterEmail")}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Step 2: Kontrahent (płatnik) */}
              {currentStep.id === "payer" && (
                <>
                  <div className="zdw-grid2">
                    <div>
                      <label className="zdw-label">NIP Płatnika {req}</label>
                      <input
                        className="zdw-input"
                        value={autoFormatNIP(form.payerNip)}
                        onChange={(e) =>
                          set("payerNip", normalizeNIP(e.target.value))
                        }
                        placeholder="123-456-78-90"
                        inputMode="numeric"
                        maxLength={13}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Nazwa płatnika {req}</label>
                      <input
                        className="zdw-input"
                        value={form.payerName}
                        onChange={handleInput("payerName")}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="zdw-label">Mail do faktur płatnika {req}</label>
                    <input
                      className="zdw-input"
                      type="email"
                      value={form.payerInvoiceEmail}
                      onChange={handleInput("payerInvoiceEmail")}
                      placeholder="faktury@firma.pl"
                    />
                  </div>
                  <div>
                    <label className="zdw-label">Faktury wystawia</label>
                    <select
                      className="zdw-select"
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
                </>
              )}

              {/* Step 3: Pytania */}
              {currentStep.id === "questions" && (
                <>
                  {[
                    {
                      key: "isCameraInstallation" as const,
                      label: "Potrzebny montaż?",
                    },
                    { key: "internetIncluded" as const, label: "Internet?" },
                    {
                      key: "interventionGroup" as const,
                      label: "Grupa interwencyjna?",
                    },
                    { key: "videoReception" as const, label: "Wideo recepcja?" },
                  ].map((q) => (
                    <div key={q.key} className="zdw-toggle-row">
                      <span className="zdw-toggle-label">{q.label}</span>
                      <YesNoToggle
                        value={form[q.key]}
                        onChange={(v) => set(q.key, v)}
                      />
                    </div>
                  ))}
                </>
              )}

              {/* Step 4: Lokalizacja obiektu */}
              {currentStep.id === "location" && (
                <LocationPicker
                  variant="dark"
                  value={form.objectLocationUrl}
                  initialAddress={form.objectAddress}
                  onChange={(url) => set("objectLocationUrl", url)}
                  onAddress={(address, city) => {
                    set("objectAddress", address);
                    set("objectCity", city);
                  }}
                />
              )}

              {/* Step 5: Dane obiektu */}
              {currentStep.id === "object" && (
                <>
                  <div>
                    <label className="zdw-label">
                      Nazwa obiektu w SAFESTAR {req}
                    </label>
                    <input
                      className="zdw-input"
                      value={form.objectName}
                      onChange={handleInput("objectName")}
                    />
                  </div>
                  <div>
                    <label className="zdw-label">Rodzaj obiektu</label>
                    <select
                      className="zdw-select"
                      value={form.objectKind}
                      onChange={(e) => set("objectKind", e.target.value)}
                    >
                      <option value="">— wybierz —</option>
                      {OBJECT_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="zdw-section">Osoba kontaktowa na miejscu</div>
                  <div>
                    <label className="zdw-label">Osoba kontaktowa {req}</label>
                    <input
                      className="zdw-input"
                      value={form.contactPerson}
                      onChange={handleInput("contactPerson")}
                    />
                  </div>
                  <div className="zdw-grid2">
                    <div>
                      <label className="zdw-label">Telefon {req}</label>
                      <input
                        className="zdw-input"
                        type="tel"
                        value={form.contactPhone}
                        onChange={handleInput("contactPhone")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Adres mailowy</label>
                      <input
                        className="zdw-input"
                        type="email"
                        value={form.contactEmail}
                        onChange={handleInput("contactEmail")}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Step 6: Montaż (only when isCameraInstallation) */}
              {currentStep.id === "installation" && (
                <div>
                  <label className="zdw-label">Nr oferty Vtools</label>
                  <input
                    className="zdw-input"
                    value={form.vtoolsOfferNumber}
                    onChange={handleInput("vtoolsOfferNumber")}
                  />
                </div>
              )}

              {/* Step 7: Zakres i warunki usługi */}
              {currentStep.id === "scope" && (
                <>
                  <div className="zdw-grid2-keep">
                    <div>
                      <label className="zdw-label">Ilość kamer</label>
                      <input
                        className="zdw-input"
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={form.cameraCount}
                        onChange={handleInput("cameraCount")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Ilość megafonów</label>
                      <input
                        className="zdw-input"
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={form.megaphoneCount}
                        onChange={handleInput("megaphoneCount")}
                      />
                    </div>
                  </div>
                  <div className="zdw-grid2">
                    <div>
                      <label className="zdw-label">Abonament (zł netto)</label>
                      <input
                        className="zdw-input"
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        value={form.monthlyAmount}
                        onChange={handleInput("monthlyAmount")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Dzierżawa (zł netto)</label>
                      <input
                        className="zdw-input"
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        value={form.rentalAmount}
                        onChange={handleInput("rentalAmount")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Długość kontraktu (mies.)</label>
                      <input
                        className="zdw-input"
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={form.contractLengthMonths}
                        onChange={handleInput("contractLengthMonths")}
                      />
                    </div>
                    <div>
                      <label className="zdw-label">Długość dzierżawy (mies.)</label>
                      <input
                        className="zdw-input"
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={form.rentalLengthMonths}
                        onChange={handleInput("rentalLengthMonths")}
                      />
                    </div>
                  </div>

                  {/* Read-only recap of step-3 answers */}
                  <div className="zdw-recap">
                    <span>
                      Internet:{" "}
                      <strong>{form.internetIncluded ? "Tak" : "Nie"}</strong>
                    </span>
                    <span>
                      Grupa interwencyjna:{" "}
                      <strong>{form.interventionGroup ? "Tak" : "Nie"}</strong>
                    </span>
                    <span>
                      Wideo recepcja:{" "}
                      <strong>{form.videoReception ? "Tak" : "Nie"}</strong>
                    </span>
                  </div>
                </>
              )}

              {/* Step 8: Terminy */}
              {currentStep.id === "terms" && (
                <>
                  {form.isCameraInstallation && (
                    <div>
                      <label className="zdw-label">
                        Przewidywany termin rozpoczęcia montażu
                      </label>
                      <input
                        className="zdw-input"
                        type="date"
                        value={form.installationStartDate}
                        onChange={handleInput("installationStartDate")}
                      />
                    </div>
                  )}
                  <div>
                    <label className="zdw-label">
                      Przewidywany termin rozpoczęcia usługi
                    </label>
                    <input
                      className="zdw-input"
                      type="date"
                      value={form.serviceStartDate}
                      onChange={handleInput("serviceStartDate")}
                    />
                  </div>
                  <div>
                    <label className="zdw-label">UWAGI</label>
                    <textarea
                      className="zdw-textarea"
                      value={form.notes}
                      onChange={handleInput("notes")}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Wizard controls */}
            <div className="zdw-nav">
              <button
                type="button"
                className="zdw-btn zdw-btn-ghost"
                onClick={handleBack}
                disabled={isFirst}
              >
                Wstecz
              </button>
              {isLast ? (
                <button
                  key="submit"
                  type="submit"
                  className="zdw-btn zdw-btn-success"
                  disabled={loading}
                >
                  {loading ? "Wysyłanie…" : "Wyślij zlecenie"}
                </button>
              ) : (
                <button
                  key="next"
                  type="button"
                  className="zdw-btn zdw-btn-primary"
                  onClick={handleNext}
                >
                  Dalej
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
