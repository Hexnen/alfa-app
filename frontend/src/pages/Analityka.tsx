/**
 * Analityka — przychód, koszt i zysk w trzech przekrojach: kontrahenta,
 * obiektu i handlowca. Reszta CRM-u odpowiada na „kto i co”; ta zakładka
 * wyłącznie na „ile z tego zostaje”.
 *
 * Powłoka nie pobiera danych. Każdy widok woła własny endpoint, bo każdy stoi
 * pod osobnym uprawnieniem (`analityka/*`) — jeden użytkownik może widzieć
 * rentowność obiektów, ale nie wynagrodzenia handlowców. Wspólny jest tylko
 * pasek narzędzi: zakres, szukajka i odświeżenie.
 */
import { useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePerms } from "@/auth/permissions";
import type { AnalyticsScope, CostWindow } from "@/lib/api";
import { KontrahenciView } from "@/components/analytics/views/KontrahenciView";
import { ObiektyView } from "@/components/analytics/views/ObiektyView";
import { HandlowcyView } from "@/components/analytics/views/HandlowcyView";

const ANALITYKA_TABS = ["kontrahenci", "obiekty", "handlowcy"] as const;
type AnalitykaTab = (typeof ANALITYKA_TABS)[number];

/** Etykiety zakresu — te same słowa, co na liście obiektów. */
const SCOPE_LABELS: Record<AnalyticsScope, string> = {
  current: "Bieżące obiekty",
  active: "Tylko aktywne",
  all: "Wszystkie, z archiwum",
};

/**
 * Okno uśredniania kosztu OSOBOWEGO (ten z Kadr; koszt pozostały jest ręczny
 * i oknem się nie rusza). Jeden miesiąc bywa wystrzałowy — premie, wyrównania,
 * choroba — a dwanaście rozmywa sezon, więc domyślne są trzy: tak samo jak
 * `DEFAULT_COST_WINDOW` w src/lib/object-personnel-cost.ts.
 */
const COST_WINDOW_LABELS: Record<CostWindow, string> = {
  1: "ostatniego miesiąca",
  3: "3 miesięcy",
  12: "12 miesięcy",
};

const COST_WINDOWS: CostWindow[] = [1, 3, 12];

/**
 * Pierwsza podzakładka, którą użytkownik naprawdę widzi.
 *
 * Sztywne przekierowanie na „kontrahenci” zamykałoby drogę komuś, kto ma
 * nadane tylko `analityka/obiekty`: wylądowałby na zakładce bez uprawnień,
 * a `AccessGuard` odesłałby go na Dashboard — z sidebara wyglądałoby to na
 * zepsuty link.
 */
function firstVisibleTab(
  canView: (key: string) => boolean
): AnalitykaTab | null {
  return ANALITYKA_TABS.find((t) => canView(`analityka/${t}`)) ?? null;
}

/** Wejście na goły `/analityka`. */
export function AnalitykaRedirect() {
  const { canView } = usePerms();
  const target = firstVisibleTab(canView);
  return <Navigate to={target ? `/analityka/${target}` : "/"} replace />;
}

export function Analityka() {
  const { tab } = useParams<{ tab: string }>();
  const { canView } = usePerms();

  // Zakres i szukajka są wspólne dla trzech widoków i mieszkają NAD `Tabs`,
  // żeby przełączenie podzakładki ich nie kasowało — ten sam idiom co pasek
  // miesiąca w Kadrach.
  const [scope, setScope] = useState<AnalyticsScope>("current");
  // Okno kosztu osobowego mieszka TU, a nie w widokach: przełączenie podzakładki
  // nie może wracać do domyślnej trójki, bo trzy widoki mówią wtedy o różnych
  // miesiącach i ich liczby przestają się do siebie odnosić.
  const [costWindow, setCostWindow] = useState<CostWindow>(3);
  const [search, setSearch] = useState("");
  // Licznik zamiast callbacku: widoki nie muszą się rejestrować w powłoce,
  // wystarczy że mają go w zależnościach efektu.
  const [reloadKey, setReloadKey] = useState(0);

  const fallback = useMemo(() => firstVisibleTab(canView), [canView]);
  const viewProps = { scope, costWindow, search, reloadKey };

  // Walidacja PO wszystkich hookach — inaczej ich liczba zmieniałaby się
  // między renderami.
  if (!tab || !ANALITYKA_TABS.includes(tab as AnalitykaTab)) {
    return <Navigate to={fallback ? `/analityka/${fallback}` : "/"} replace />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={scope}
          onValueChange={(v) => setScope(v as AnalyticsScope)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Zakres" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCOPE_LABELS) as AnalyticsScope[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={String(costWindow)}
          onValueChange={(v) => setCostWindow(Number(v) as CostWindow)}
        >
          <SelectTrigger
            className="w-[260px]"
            title="Z ilu ostatnich pełnych miesięcy uśredniamy koszt osobowy liczony z wypłat w Kadrach. Koszt pozostały (monitoring, sprzęt) jest ręczny i nie zależy od tego wyboru."
          >
            <SelectValue placeholder="Koszt osobowy z" />
          </SelectTrigger>
          <SelectContent>
            {COST_WINDOWS.map((w) => (
              <SelectItem key={w} value={String(w)}>
                Koszt osobowy z: {COST_WINDOW_LABELS[w]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj: nazwa / miasto / handlowiec…"
            className="pl-8"
          />
        </div>

        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Odśwież
        </Button>
      </div>

      {/* Bez `TabsList` — paskiem zakładek jest sidebar, a każda podzakładka
          ma własny adres. */}
      <Tabs value={tab}>
        <TabsContent value="kontrahenci" className="space-y-3">
          <KontrahenciView {...viewProps} />
        </TabsContent>
        <TabsContent value="obiekty" className="space-y-3">
          <ObiektyView {...viewProps} />
        </TabsContent>
        <TabsContent value="handlowcy" className="space-y-3">
          <HandlowcyView {...viewProps} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
