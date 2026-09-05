/**
 * Oferta dla klienta pod linkiem: /oferta/:token — BEZ logowania.
 *
 * Trasa jest rodzeństwem `/*` w `App.tsx`, czyli stoi poza `AuthedApp`: nie ma
 * tu `Layout`, menu ani bramki `useAuth`, dokładnie jak przy publicznym
 * formularzu ZDW. Klient ma zobaczyć dokument, wydrukować go i zapisać PDF —
 * nic więcej.
 *
 * Dane biorą się z trasy `/api/public-offer/:token`, która zwraca JAWNĄ BIAŁĄ
 * LISTĘ pól (bez kosztów, marży, uwag wewnętrznych i niewybranych wariantów).
 * Dokument składa ten sam `buildOfferHtml`, którego używa wydruk w aplikacji,
 * więc handlowiec w podglądzie widzi dokładnie to samo co klient.
 *
 * „Pobranie PDF" to okno druku przeglądarki z miejscem docelowym „Zapisz jako
 * PDF" — w projekcie nie ma serwerowego generowania PDF i wszystkie dokumenty
 * (wycena, protokół, kadry) działają tak samo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchPublicOffer, type PublicOfferDetail } from "@/lib/api";
import { buildOfferHtml, printOffer } from "@/lib/offerPrint";
import "./PublicOffer.css";

const LOGO_URL =
  "https://alfagroup.com.pl/wp-content/uploads/2023/07/alfagroup_logo_navbar.png";

/** Wysokość A4 przy 96 dpi — zanim zmierzymy realną wysokość dokumentu. */
const A4_HEIGHT_PX = 1123;

export function PublicOffer() {
  const { token = "" } = useParams<{ token: string }>();
  /*
   * Wynik trzymamy RAZEM z tokenem, dla którego powstał. Dzięki temu przy
   * zmianie adresu nie trzeba zerować stanu na wejściu do efektu (co jest
   * kaskadowym renderem), a i tak nigdy nie pokażemy dokumentu spod starego
   * linku — po prostu `loaded !== token` znaczy „jeszcze wczytuję".
   */
  const [state, setState] = useState<{
    token: string;
    detail: PublicOfferDetail | null;
    error: { title: string; text: string } | null;
  }>({ token: "", detail: null, error: null });
  const [docH, setDocH] = useState(A4_HEIGHT_PX);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    fetchPublicOffer(token)
      .then((res) => {
        if (alive) setState({ token, detail: res.data ?? null, error: null });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        /*
         * Nie rozróżniamy „nie ma takiej oferty" od „link wyłączony" ani od
         * „token za krótki" — backend odpowiada 404 na każdy zły token, żeby
         * nie potwierdzać istnienia dokumentu. Po stronie klienta rozróżniamy
         * TYLKO brak odpowiedzi (sieć, 5xx — `status` pusty albo ≥ 500) od
         * odpowiedzi odmownej. W żadnym wariancie nie pokazujemy `e.message`
         * z backendu: to strona bez logowania, a komunikat walidacji zdradzałby
         * kształt tokenu i wewnętrzne nazwy pól.
         */
        const status = (e as { status?: number })?.status;
        const serverDown = status === undefined || status >= 500;
        setState({
          token,
          detail: null,
          error: serverDown
            ? {
                title: "Nie udało się wczytać oferty",
                text: "Spróbuj odświeżyć stronę za chwilę.",
              }
            : {
                title: "Nie znaleziono oferty",
                text: "Ten link jest nieprawidłowy lub został wyłączony. Prosimy o kontakt z osobą, która przesłała ofertę.",
              },
        });
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const loaded = state.token === token;
  const detail = loaded ? state.detail : null;
  const error = loaded ? state.error : null;

  /* Ramka rośnie do wysokości dokumentu, żeby strona przewijała się jako całość,
     a nie dokument wewnątrz ramki wewnątrz strony. */
  const measure = useCallback(() => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (doc) setDocH(Math.max(600, doc.documentElement.scrollHeight + 8));
    } catch {
      setDocH(A4_HEIGHT_PX);
    }
  }, []);

  if (error) {
    return (
      <div className="ofr-page">
        <div className="ofr-state">
          <h2>{error.title}</h2>
          <p>{error.text}</p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="ofr-page">
        <div className="ofr-state">
          <h2>Wczytuję ofertę…</h2>
          <p>Chwileczkę.</p>
        </div>
      </div>
    );
  }

  // Projekcja publiczna spełnia `PrintCompany` strukturalnie — bez rzutowań.
  const company = detail.company;

  const html = buildOfferHtml(detail, {
    audience: "client",
    company,
    withPrintButton: false,
    pageFrame: false,
  });

  return (
    <div className="ofr-page">
      <div className="ofr-bar">
        <img className="ofr-logo" src={LOGO_URL} alt="Alfa Group" />
        <div className="ofr-heading">
          <h1 className="ofr-title">Oferta {detail.offer.number}</h1>
          <p className="ofr-sub">
            {detail.offer.site || detail.offer.clientName || "Oferta handlowa"}
          </p>
        </div>
        <div className="ofr-actions">
          <button
            type="button"
            className="ofr-btn"
            onClick={() =>
              printOffer(detail, { audience: "client", company })
            }
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <path d="M6 14h12v8H6z" />
            </svg>
            Drukuj / zapisz PDF
          </button>
        </div>
      </div>

      {detail.isExpired && (
        <div className="ofr-note">
          Ta oferta straciła ważność
          {detail.offer.validUntil ? ` ${detail.offer.validUntil}` : ""} — prosimy
          o kontakt, przygotujemy aktualną wycenę.
        </div>
      )}

      <div className="ofr-doc">
        <iframe
          ref={frameRef}
          title={`Oferta ${detail.offer.number}`}
          className="ofr-frame"
          style={{ height: docH }}
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={measure}
        />
      </div>
    </div>
  );
}
