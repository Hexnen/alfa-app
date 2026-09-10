/**
 * SZANSE I OSOBY KONTAKTOWE NA KARCIE OBIEKTU I KONTRAHENTA.
 *
 * Lejek handlowy ma własny moduł, ale jego dwa najbardziej „kartotekowe” byty —
 * szanse przypięte do obiektu/kontrahenta i osoby kontaktowe — muszą być widoczne
 * TAM, gdzie się o kliencie rozmawia. Stąd jeden komponent zamiast dwóch kopii:
 * kartoteka obiektu i kartoteka kontrahenta pokazują dokładnie to samo, tylko
 * z innym filtrem.
 *
 * Uprawnienia rozstrzygamy tutaj, a nie u wywołującego: sekcja bez klucza
 * `handlowy/leady` / `handlowy/kontakty` nie renderuje się w ogóle i nie strzela
 * zapytaniem, które i tak wróciłoby 403.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Handshake, Mail, Phone, Plus, Star, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePerms } from "@/auth/permissions";
import { contactsApi, leadsApi, type Contact, type Lead } from "@/lib/api";
import { LEAD_STAGE_META, leadHref, stagePillClass } from "@/lib/sales-labels";
import { formatCurrency } from "@/lib/utils";
import { ContactDialog } from "./ContactDialog";

/**
 * Do czego przypięte są szanse i kontakty. Dwa osobne propsy zamiast unii
 * obiektów: identyfikatory to liczby, więc wchodzą wprost w listę zależności
 * efektu — obiekt tworzony w renderze rodzica odpalałby zapytanie co render.
 */
export interface SalesScopeProps {
  contractorId?: number | null;
  objectId?: number | null;
}

/** Szanse sprzedaży przypięte do obiektu albo kontrahenta (także zamknięte). */
export function LeadsSection({ contractorId, objectId }: SalesScopeProps) {
  const [items, setItems] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // `includeClosed` świadomie: na karcie klienta historia przegranych szans
    // jest równie ważna, co otwarte — mówi, o co ten klient już pytał.
    leadsApi
      .list({
        contractorId: contractorId ?? undefined,
        objectId: objectId ?? undefined,
        includeClosed: true,
        pageSize: 50,
      })
      .then((res) => {
        if (!cancelled) setItems(res.data?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Nie udało się wczytać szans sprzedaży.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contractorId, objectId]);

  return (
    <Card data-testid="sekcja-szanse">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake className="h-4 w-4 text-muted-foreground" />
          Szanse sprzedaży
          {items.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Brak szans sprzedaży powiązanych z tą kartoteką.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((lead) => {
              const meta = LEAD_STAGE_META[lead.stage];
              return (
                <li key={lead.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Link
                    to={leadHref(lead.id)}
                    className="font-medium text-primary hover:underline"
                    data-testid="sekcja-szanse-link"
                  >
                    {lead.title}
                  </Link>
                  {meta && (
                    <span className={stagePillClass(lead.stage, { compact: true })}>
                      {meta.label}
                    </span>
                  )}
                  {lead.estimatedMonthly != null && (
                    <span className="tabular-nums text-muted-foreground">
                      {formatCurrency(lead.estimatedMonthly)}/mies.
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {lead.salespersonName ?? "bez handlowca"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Osoby kontaktowe kartoteki — z dodawaniem przez wspólny `ContactDialog`. */
export function ContactsSection({
  contractorId,
  objectId,
  editable,
}: SalesScopeProps & {
  /** Czy pokazać „Dodaj” — zgodne z prawem edycji EKRANU, na którym stoi sekcja. */
  editable: boolean;
}) {
  const [items, setItems] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return contactsApi
      .list({
        contractorId: contractorId ?? undefined,
        objectId: objectId ?? undefined,
        pageSize: 50,
      })
      .then((res) => setItems(res.data ?? []))
      .catch(() => setError("Nie udało się wczytać osób kontaktowych."))
      .finally(() => setLoading(false));
  }, [contractorId, objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card data-testid="sekcja-kontakty">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          Osoby kontaktowe
          {items.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
          )}
        </CardTitle>
        {editable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialogOpen(true)}
            data-testid="sekcja-kontakty-dodaj"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Dodaj
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Ładowanie…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Brak osób kontaktowych. Bez nazwiska i telefonu każdy kontakt zaczyna się od zera.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((contact) => (
              <li key={contact.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium">
                  {contact.fullName || `${contact.firstName} ${contact.lastName}`.trim()}
                </span>
                {contact.isPrimary && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-amber-600"
                    title="Osoba główna"
                  >
                    <Star className="h-3 w-3 fill-current" />
                    główna
                  </span>
                )}
                {contact.role && (
                  <span className="text-xs text-muted-foreground">{contact.role}</span>
                )}
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Phone className="h-3 w-3" />
                    {contact.phone}
                  </a>
                )}
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Mail className="h-3 w-3" />
                    {contact.email}
                  </a>
                )}
                {!contact.active && (
                  <span className="text-xs text-muted-foreground">(nieaktywna)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {dialogOpen && (
        <ContactDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          contact={null}
          defaults={{ contractorId: contractorId ?? null, objectId: objectId ?? null }}
          onSaved={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Obie sekcje naraz — każda za swoim kluczem uprawnień. Gdy użytkownik nie ma
 * żadnego z nich, komponent nie renderuje niczego (i nie zostawia pustej dziury
 * w siatce karty).
 */
export function SalesEntitySections({
  contractorId,
  objectId,
  editable,
  className,
}: SalesScopeProps & {
  editable: boolean;
  className?: string;
}) {
  const { canView, canEdit } = usePerms();
  const showLeads = canView("handlowy/leady");
  const showContacts = canView("handlowy/kontakty");
  if (!showLeads && !showContacts) return null;
  return (
    <div className={className}>
      {showLeads && <LeadsSection contractorId={contractorId} objectId={objectId} />}
      {showContacts && (
        <ContactsSection
          contractorId={contractorId}
          objectId={objectId}
          editable={editable && canEdit("handlowy/kontakty")}
        />
      )}
    </div>
  );
}
