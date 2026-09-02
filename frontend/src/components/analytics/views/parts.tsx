/**
 * Drobne komponenty wspólne dla trzech widoków analityki: stany zastępcze
 * zasobu, onboarding braku kosztów i nagłówek sortowania tabeli.
 *
 * Osobny plik od `./shared`, bo tam mieszka logika (hooki, komparatory,
 * formuły) — plik mieszający jedno z drugim psuje fast refresh.
 */
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronsUpDown, Coins, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/analytics";
import type { PersonnelInfo } from "@/lib/api";
import { cmaNote, personnelNote, type LoadState } from "./shared";

/**
 * Ekran zastępczy dla stanów innych niż „mamy dane”. Ponowną próbę robi
 * przycisk „Odśwież” z paska narzędzi — nie dublujemy go w każdej karcie.
 */
export function ResourceNotice({
  state,
}: {
  state: Exclude<LoadState, "ready">;
}) {
  if (state === "loading") {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Ładowanie danych…
        </CardContent>
      </Card>
    );
  }
  if (state === "forbidden") {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <p className="text-sm font-medium text-slate-700">
            Brak uprawnień do tego widoku
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            O dostęp poproś administratora systemu.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-10 text-center">
        <p className="text-sm font-medium text-slate-700">
          Nie udało się wczytać danych
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Spróbuj ponownie przyciskiem „Odśwież” nad zakładkami.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Onboarding pierwszego dnia: dopóki nikt nie wpisał ani jednego kosztu,
 * wykresy zysku i marży nie mają czego rysować. Ściana zer wyglądałaby jak
 * awaria, a marża 100% jak sukces — więc zamiast wykresu mówimy wprost,
 * czego brakuje i gdzie to uzupełnić.
 */
export function NoCostEmpty({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Coins}
      title="Brak danych kosztowych"
      description={`Żaden obiekt nie ma jeszcze uzupełnionego kosztu miesięcznego, więc ${what} nie da się policzyć.`}
      actionLabel="Uzupełnij koszty obiektów"
      actionHref="/objects?hasCost=0"
    />
  );
}

/**
 * Przypis pod kafelkami KPI: skąd wziął się koszt osobowy i w jakim sensie
 * wszystkie kwoty są „netto".
 *
 * Dwie rzeczy, których nie wolno przemilczeć:
 *  0. „Godziny poza obiektami" to dwie rzeczy naraz: pozycje kadrowe bez
 *     mapowania ORAZ godziny działowe (Kadry → Działy), których zmapować się
 *     nie da — dział z definicji nie należy do jednego klienta.
 *  1. Bez mapowania `hr_objects.object_id` → obiekt koszt osobowy wynosi zero
 *     i CAŁA ta funkcja milczy. Zero wygląda wtedy jak wynik („tani obiekt"),
 *     a jest dziurą w danych — dlatego zamiast przypisu leci wtedy komunikat
 *     z linkiem do miejsca, w którym można to naprawić.
 *  2. Koszt osobowy ma DWIE ścieżki: alokację wprost z godzin i udział w puli
 *     centrum monitorowania (blisko połowa kwoty). Przypis milczał o drugiej,
 *     więc czytelnik widział „zmapowano N pozycji" i miał prawo sądzić, że to
 *     wszystko. Obiekty z kamerami bez podanej ILOŚCI nie dostają wagi za
 *     kamery — ich koszt jest zaniżony i to musi być widać, a nie zgadywane.
 *  3. „Netto" znaczy tu dwie różne rzeczy: strona handlowa jest bez VAT,
 *     a wypłaty są „na rękę". Do wypłat doliczamy narzut składek pracodawcy,
 *     więc koszt osobowy jest SZACOWANYM pełnym kosztem zatrudnienia — ale
 *     mnożnik przelicza z netto, choć składki liczy się od brutto, więc to
 *     przybliżenie. Kto tego nie wie, weźmie mnożnik za kwotę z listy płac.
 */
export function PersonnelFootnote({ personnel }: { personnel: PersonnelInfo }) {
  const mapped = personnel.mappedObjects > 0;
  const cma = cmaNote(personnel);
  const missingCameras = personnel.cma.objectsMissingCameraCount;

  return (
    <div className="space-y-1 px-1">
      {mapped ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{personnelNote(personnel)}</span>
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-xs text-amber-600">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Koszt osobowy nie jest liczony:{" "}
            {personnel.hrObjectsTotal > 0
              ? `żadna z ${personnel.hrObjectsTotal} pozycji kadrowych nie wskazuje obiektu z kartoteki`
              : "w Kadrach nie ma jeszcze pozycji do zmapowania"}
            , więc w koszcie widać wyłącznie kwoty wpisane ręcznie w obiektach.{" "}
            <Link
              to="/kadry/obiekty"
              className="font-medium underline underline-offset-2 hover:text-amber-700"
            >
              zmapuj pozycje kadrowe
            </Link>
          </span>
        </p>
      )}
      {cma && (
        <p className="text-xs text-muted-foreground">
          {cma}
          {missingCameras > 0 && (
            <>
              {" "}
              <span className="text-amber-600">
                {missingCameras}{" "}
                {missingCameras === 1
                  ? "obiekt ma usługę kamer bez podanej ilości i nie dostaje za nie wagi — jego koszt jest zaniżony"
                  : "obiektów ma usługę kamer bez podanej ilości i nie dostaje za nie wagi — ich koszt jest zaniżony"}
                .{" "}
                <Link
                  to="/objects"
                  className="font-medium underline underline-offset-2 hover:text-amber-700"
                >
                  uzupełnij liczbę kamer
                </Link>
              </span>
            </>
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Kwoty handlowe (abonamenty, koszty, nakłady) są <strong>netto</strong> —
        bez VAT.
        {mapped && (
          <>
            {" "}
            Koszt osobowy pochodzi z wypłat powiększonych o narzut składek
            pracodawcy (średnio ×{personnel.employer.effectiveMarkup.toFixed(2)}
            ). Składki liczy się od brutto, a mnożnik przelicza z netto, więc to{" "}
            <strong>szacunek</strong> — narzuty ustawia się w Administracja →
            Firma.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Nagłówek klikalny — idiom przepisany z `Objects.tsx:300-330`. Tam sortowanie
 * idzie do API; tutaj wszystkie wiersze są już w pamięci, więc stan sortowania
 * trzyma widok, a układ i strzałki zostają te same.
 */
export function SortHeader({
  label,
  sortKey,
  active,
  dir,
  align = "left",
  onToggle,
  tip,
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
  onToggle: (key: string) => void;
  tip?: string;
}) {
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      title={tip}
      className={cn(
        "py-3 px-2 font-medium",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
      </button>
    </th>
  );
}
