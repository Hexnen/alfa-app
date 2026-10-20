import { useMemo, useState } from "react";
import { MapPin, Navigation, Phone } from "lucide-react";
import { ConfirmDialog } from "../ui/confirm";
import { extractNoteActions, type NotePhone } from "../lib/note-actions";
import { cn } from "@/lib/utils";
import { Kafel } from "./KafleAkcji";

/**
 * KAFLE Z TREŚCI NOTATKI — „Zadzwoń 600 123 456”, „Mapa”, „Nawiguj”.
 *
 * Te same kafle co „Nawiguj”/„Zadzwoń” pod nagłówkiem zlecenia (`Kafel` z
 * `KafleAkcji`): duży cel dotykowy zamiast numeru albo długiego adresu
 * w środku zdania. Telefon przez potwierdzenie — jak w kaflu kontaktu, bo
 * przypadkowe dotknięcie w aucie dzwoniłoby bez ostrzeżenia.
 *
 * Wspólne dla panelu technika i strony linku `/u/:token`. Nic nie pobiera z
 * sieci (wyciąganie w `lib/note-actions.ts`), więc działa też bez sesji.
 */
export function KafleNotatki({
  text,
  excludePhones,
  excludeMapsUrls,
  className,
}: {
  text: string | null | undefined;
  /** Numery pokazane już wyżej (kafel „Zadzwoń” zlecenia) — bez dubla. */
  excludePhones?: (string | null | undefined)[];
  excludeMapsUrls?: (string | null | undefined)[];
  className?: string;
}) {
  const excludeKey = `${(excludePhones ?? []).join("|")}#${(excludeMapsUrls ?? []).join("|")}`;
  const actions = useMemo(
    () => extractNoteActions(text, { phones: excludePhones, mapsUrls: excludeMapsUrls }),
    // `excludeKey` zastępuje tablice, które rodzic tworzy przy każdym renderze.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, excludeKey],
  );
  const [call, setCall] = useState<NotePhone | null>(null);

  if (actions.length === 0) return null;

  return (
    <div
      className={cn("grid grid-cols-2 gap-2", className)}
      data-testid="notatka-kafle"
      // Kafle siedzą w karcie wpisu — klik ma wykonać akcję, nie nic więcej.
      onClick={(e) => e.stopPropagation()}
    >
      {actions.map((a) =>
        a.kind === "phone" ? (
          <Kafel
            key={a.href}
            icon={Phone}
            label="Zadzwoń"
            sub={a.display}
            href={a.href}
            onClick={() => setCall(a)}
            disabledReason={null}
            testId="notatka-kafel-telefon"
          />
        ) : (
          <MapaKafle key={a.href} href={a.href} navHref={a.navHref} provider={a.provider} lat={a.lat} lng={a.lng} />
        ),
      )}
      <ConfirmDialog
        open={call !== null}
        onOpenChange={(o) => !o && setCall(null)}
        title={`Zadzwonić pod ${call?.display ?? "ten numer"}?`}
        description="Numer wpisany w treści."
        confirmLabel="Zadzwoń"
        variant="default"
        onConfirm={() => {
          const href = call?.href;
          setCall(null);
          if (href) window.location.assign(href);
        }}
      />
    </div>
  );
}

/** Link do map: „Mapa” (oryginał — z nazwą miejsca) + „Nawiguj”, gdy znamy punkt. */
function MapaKafle({
  href,
  navHref,
  provider,
  lat,
  lng,
}: {
  href: string;
  navHref: string | null;
  provider: string;
  lat: number | null;
  lng: number | null;
}) {
  // Współrzędne nic nie mówią człowiekowi (i zawijały się na 390 px) — podpis
  // mówi, co się stanie po dotknięciu.
  const hasPoint = lat !== null && lng !== null;
  return (
    <>
      <Kafel
        icon={MapPin}
        label="Mapa"
        sub={provider}
        href={href}
        external
        disabledReason={null}
        testId="notatka-kafel-mapa"
      />
      {navHref && (
        <Kafel
          icon={Navigation}
          label="Nawiguj"
          sub={hasPoint ? "trasa do pinezki" : null}
          href={navHref}
          external
          disabledReason={null}
          testId="notatka-kafel-nawiguj"
        />
      )}
    </>
  );
}
