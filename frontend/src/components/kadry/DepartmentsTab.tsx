// Podzakładka Kadry → Działy: słownik działów firmy do wpisów godzin.
//
// Dział jest rodzeństwem pozycji kadrowej, nie jej odmianą: godziny działu to
// koszt ogólny firmy, więc dział NIE mapuje się na obiekt z kartoteki —
// przypisanie go do jednego klienta obciążyłoby go kosztem wszystkich.
// Stąd osobny ekran obok Obiektów, a nie kolejna kolumna w tamtej tabeli.
//
// Osobny plik od `Kadry.tsx` z prozaicznego powodu: tamten ma już 1900 linii
// i kolejna tabela inline pogorszyłaby go bez żadnego zysku.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Building2, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { EntityHistory } from "./EntityHistory";
import { KadryHelp } from "./KadryHelp";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  createHrDepartment,
  deleteHrDepartment,
  updateHrDepartment,
  type HrDepartment,
  type HrPortalKey,
} from "@/lib/api";
import { PILL_TONE, pluralPl } from "@/lib/calendar-labels";
import { hrs, TABLE_SELECT_CLS } from "./shared";
import { Th } from "./parts";
import {
  DEPARTMENT_COLOR_TONES,
  DEPARTMENT_PORTALS,
  EmptyRow,
  IconButton,
  KadryBadge,
  RowActions,
  TEXT_TONE,
  THEAD_CLS,
  TONE_LABELS,
  departmentTone,
} from "./ui";
import { useConfirm } from "./useConfirm";

/** „1 osoba / 2 osoby / 5 osób" — wspólny helper odmiany z etykiet kalendarza. */
const persons = (n: number) => pluralPl(n, "osoba", "osoby", "osób");

/**
 * Kod HTTP z błędu `request()` — 409 przy usuwaniu znaczy „dział ma godziny lub
 * ludzi" (do potwierdzenia) ALBO „dział jest pulą CMA" (bez obejścia).
 */
const errStatus = (e: unknown): number =>
  typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status?: unknown }).status) || 0
    : 0;

const errMessage = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

export function DepartmentsTab({
  departments,
  editable,
  loading,
  onChanged,
}: {
  departments: HrDepartment[];
  editable: boolean;
  loading: boolean;
  /** Zmiana słownika — rodzic przeładowuje działy (i etykiety w Godzinach). */
  onChanged: () => Promise<void> | void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Wiersz w trakcie zmiany nazwy: id → tekst w polu (jak w Obiektach). */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * Powód ODMOWY przełącznika, per wiersz (id → komunikat z backendu).
   *
   * Backend pilnuje dwóch niezmienników flag: dział-pula nie może być obiektowy
   * (400), a znacznika „obiektowy” nie da się zdjąć z działu, w którym wiszą
   * wpisy godzin z obiektem (409 z ich liczbą). Sam pasek błędu nad tabelą nie
   * mówi, KTÓREGO wiersza dotyczy odmowa — dlatego powód wraca też do dymka
   * tego konkretnego przełącznika i zostaje tam do następnej próby.
   */
  const [denied, setDenied] = useState<Record<string, string>>({});
  const denyKey = (id: number, flag: "pool" | "objects") => `${id}:${flag}`;
  const confirm = useConfirm();

  // Kolejność ustawia użytkownik (`sortOrder` 10, 20, …), a nazwa rozstrzyga
  // remisy — bez tie-breaka wiersze skakałyby po każdym zapisie.
  const sorted = useMemo(
    () =>
      [...departments].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pl"),
      ),
    [departments],
  );

  /**
   * Każda zmiana idzie tą samą ścieżką: zapis → przeładowanie słownika.
   *
   * Błąd ląduje w pasku nad tabelą, nie w `alert()`: przy komunikacie widać
   * wiersz, którego dotyczy, treść da się skopiować, a okno przeglądarki nie
   * blokuje wątku. Zwraca `true` przy powodzeniu — korzysta z tego edycja nazwy,
   * która zamyka pole dopiero po udanym zapisie.
   */
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    if (!editable || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      setError(errMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await createHrDepartment({ name });
      setNewName("");
    }, "Błąd dodawania działu");
  };

  /**
   * Zmiana nazwy w wierszu, jak w Obiektach: `window.prompt` to okienko bez
   * kontekstu, w którym nie widać ani reszty listy, ani tego, ile godzin wisi
   * na dziale.
   *
   * Edycja operuje na SUROWEJ nazwie, choć tabela pokazuje etykietę z prefiksem
   * firmy: prefiks pochodzi z ustawień (Administracja → Firma), nie jest częścią
   * nazwy i wpisanie go tutaj zdublowałoby go na ekranie.
   */
  const commitRename = async () => {
    if (!renaming) return;
    const row = departments.find((d) => d.id === renaming.id);
    const name = renaming.value.trim();
    if (!row || !name || name === row.name) {
      setRenaming(null);
      return;
    }
    const ok = await run(
      () => updateHrDepartment(row.id, { name }),
      "Błąd zapisu działu",
    );
    if (ok) setRenaming(null);
  };

  const handleToggleActive = (row: HrDepartment) =>
    void run(
      () => updateHrDepartment(row.id, { active: !row.active }),
      "Błąd zapisu działu",
    );

  /**
   * Przełącznik flagi z zapamiętaniem powodu odmowy przy TYM wierszu.
   * Sukces czyści poprzedni powód — dymek nie ma straszyć nieaktualnym 409.
   */
  const toggleFlag = async (
    row: HrDepartment,
    flag: "pool" | "objects",
    patch: Parameters<typeof updateHrDepartment>[1],
    fallback: string,
  ) => {
    if (!editable || busy) return false;
    const key = denyKey(row.id, flag);
    setBusy(true);
    setError(null);
    try {
      await updateHrDepartment(row.id, patch);
      await onChanged();
      setDenied((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
      return true;
    } catch (err) {
      const msg = errMessage(err, fallback);
      setError(msg);
      setDenied((p) => ({ ...p, [key]: msg }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const togglePool = (row: HrDepartment) =>
    toggleFlag(
      row,
      "pool",
      { isCmaPool: !row.isCmaPool },
      "Błąd zapisu znacznika puli",
    );

  const handleTogglePool = (row: HrDepartment) => {
    // Zdjęcie znacznika jest nieszkodliwe (koszt wraca do kosztu ogólnego),
    // więc pytamy tylko przy nadawaniu — bo odbiera je innemu działowi.
    if (row.isCmaPool) {
      void togglePool(row);
      return;
    }
    confirm.ask({
      title: `Oznaczyć „${row.name}" jako dział-pulę?`,
      description:
        "Koszt godzin takiego działu rozdziela się na WSZYSTKIE dozorowane obiekty, " +
        "zamiast obciążać jednego klienta. Pula może być tylko jedna — poprzedni " +
        "dział-pula straci ten znacznik.",
      confirmLabel: "Oznacz jako pulę",
      destructive: false,
      // Przez `toggleFlag`, a nie wprost: odmowa backendu (np. dział jest
      // obiektowy) ma trafić do paska błędu i do dymka wiersza, a nie polecieć
      // jako nieobsłużony wyjątek w oknie potwierdzenia.
      onConfirm: async () => {
        await toggleFlag(
          row,
          "pool",
          { isCmaPool: true },
          "Błąd zapisu znacznika puli",
        );
      },
    });
  };

  /**
   * Dział obiektowy (w praktyce OFI). Zdjęcie flagi nie ruszy wpisów, które już
   * wskazują obiekt w tym dziale, ale od razu zablokuje kolejne — dlatego
   * pytamy, zanim ktoś kliknie to w przelocie. Zaznaczenie jest nieszkodliwe
   * (tylko poszerza to, co wolno wpisać), więc idzie bez pytania.
   */
  const handleToggleObjects = (row: HrDepartment) => {
    if (!row.hasObjects) {
      void toggleFlag(
        row,
        "objects",
        { hasObjects: true },
        "Błąd zapisu znacznika działu obiektowego",
      );
      return;
    }
    confirm.ask({
      title: `Zdjąć z działu „${row.name}" znacznik działu obiektowego?`,
      description:
        "W dziale bez tego znacznika wpis godzin NIE może wskazać obiektu. " +
        "Jeśli takie wpisy już tu są, backend odmówi — inaczej przestałoby się " +
        "dać zapisać którykolwiek z nich (zapis komórki wysyła cały wiersz).",
      confirmLabel: "Zdejmij znacznik",
      destructive: false,
      onConfirm: async () => {
        await toggleFlag(
          row,
          "objects",
          { hasObjects: false },
          "Błąd zapisu znacznika działu obiektowego",
        );
      },
    });
  };

  /**
   * Kolor działu. Klik w kropkę zapisuje od razu — to jedno pole wyboru
   * z dziewięciu, więc osobny dialog i przycisk „Zapisz" byłyby ceremonią
   * dłuższą od samej zmiany. Klik w aktualny kolor zdejmuje go (`null`).
   */
  const handleColor = (row: HrDepartment, tone: string) =>
    void run(
      () => updateHrDepartment(row.id, { color: row.color === tone ? null : tone }),
      "Błąd zapisu koloru działu",
    );

  /**
   * PORTAL DZIAŁU — sekcja sidebara, która wypełnia godziny tego działu sama
   * („Godziny działu” w CMA, OFI, Handlowym i Technicznym). To pole decyduje,
   * KTO widzi wiersze działu poza pełnymi Kadrami, więc zmiana idzie do
   * dziennika jak każda inna (pole `portal`).
   *
   * Zapis od razu po wyborze, jak przy kolorze: jedno pole wyboru nie
   * potrzebuje dialogu z przyciskiem „Zapisz".
   */
  const handlePortal = (row: HrDepartment, value: string) =>
    void run(
      // Wartość pochodzi z `DEPARTMENT_PORTALS`, więc rzutowanie jest tu opisem
      // faktu, a nie obejściem — backend i tak sprawdza ją whitelistą.
      () =>
        updateHrDepartment(row.id, {
          portal: value === "" ? null : (value as HrPortalKey),
        }),
      "Błąd zapisu portalu działu",
    );

  const handleOrder = (row: HrDepartment, value: string) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n === row.sortOrder) return;
    void run(
      () => updateHrDepartment(row.id, { sortOrder: n }),
      "Błąd zapisu kolejności",
    );
  };

  /**
   * Co zostanie odpięte przy usunięciu działu — z liczników wiersza, żeby już
   * PIERWSZE pytanie mówiło o skutkach, a nie dopiero odpowiedź 409. Pusty
   * string = dział bez godzin i bez ludzi, zwykłe „Usunąć?" wystarczy.
   */
  const deleteImpact = (row: HrDepartment): string => {
    const parts: string[] = [];
    if (row.hoursTotal > 0 || row.hoursEmployeesCount > 0) {
      parts.push(
        `${hrs(row.hoursTotal)} godz. od ${persons(row.hoursEmployeesCount)} — wpisy ` +
          "stracą przypisanie i trafią do kosztu ogólnego",
      );
    }
    if (row.employeesCount > 0) {
      parts.push(
        `${persons(row.employeesCount)} w kartotece — zostaną bez macierzystego działu`,
      );
    }
    // Jedno zdanie, nie lista z myślnikami: opis okna potwierdzenia to akapit,
    // a `\n` nic w nim nie znaczy.
    return parts.length
      ? `Na dziale „${row.name}" wisi: ${parts.join("; ")}.`
      : "";
  };

  /** Czy wiersz zapowiada, że backend odpowie 409 bez `force`. */
  const hasDependents = (row: HrDepartment) =>
    row.hoursTotal > 0 || row.employeesCount > 0 || row.hoursEmployeesCount > 0;

  /**
   * Usunięcie działu. Wiersze i ludzie przeżyją usunięcie (`ON DELETE SET NULL`),
   * ale stracą przypisanie; dla biura, które godzin nie księguje, to przypisanie
   * jest jedyne i nie ma skąd go odtworzyć. Dlatego:
   *  - dział-pula CMA nie ma tu kosza w ogóle (backend i tak odpowie 409 bez
   *    obejścia) — flagę trzeba najpierw przenieść na inny dział;
   *  - dział z licznikami > 0 pyta RAZ, ze skutkami z wiersza, i po potwierdzeniu
   *    idzie od razu z `force` — wcześniej padały dwa dialogi o tym samym
   *    (pierwszy ze skutkami, potem 409 i drugi z tymi samymi skutkami);
   *  - 409 zostaje ścieżką awaryjną na „wiersz mówił 0, serwer inaczej" (ktoś
   *    dopisał godziny od ostatniego odświeżenia) — wtedy drugie pytanie jest
   *    uzasadnione, bo pierwsze nie mówiło o skutkach.
   */
  const handleDelete = (row: HrDepartment) => {
    if (!editable || busy || row.isCmaPool) return;
    const impact = deleteImpact(row);
    const withForce = hasDependents(row);
    setError(null);
    confirm.ask({
      title: `Usunąć dział ${row.name}?`,
      description:
        [impact, withForce ? "Tej operacji nie da się cofnąć." : ""]
          .filter(Boolean)
          .join(" ") || "Dział zniknie ze słownika wpisów godzin.",
      onConfirm: async () => {
        try {
          await deleteHrDepartment(row.id, withForce);
          await onChanged();
        } catch (err) {
          // Każdy błąd poza „409 bez force" zostaje w otwartym oknie (w tym 409
          // puli CMA, gdy wiersz był nieświeży i kosz się w ogóle pokazał) —
          // komunikat serwera mówi, co z tym zrobić.
          if (errStatus(err) !== 409 || withForce) throw err;
          // 409 mimo zerowych liczników w wierszu: ktoś dopisał godziny od
          // ostatniego odświeżenia. Drugie pytanie jest uzasadnione, bo
          // pierwsze o skutkach nie mówiło. `setTimeout` oddaje pierwszeństwo
          // zamknięciu bieżącego okna — inaczej `onClose` skasowałby nowe
          // pytanie tuż po jego ustawieniu.
          const reason = errMessage(
            err,
            "Dział ma przypisane godziny lub pracowników.",
          );
          window.setTimeout(
            () =>
              confirm.ask({
                title: `Usunąć dział ${row.name} mimo to?`,
                description: `${reason} Wpisy i osoby zostaną, ale stracą przypisanie do działu. Tej operacji nie da się cofnąć.`,
                confirmLabel: "Usuń mimo to",
                onConfirm: async () => {
                  await deleteHrDepartment(row.id, true);
                  await onChanged();
                },
              }),
            0,
          );
        }
      },
    });
  };

  return (
    <>
      {/* Banera „tylko do odczytu" nie dublujemy: `Kadry.tsx` renderuje go nad
          zakładkami dla klucza aktywnej podzakładki, więc `kadry/dzialy` bez
          edycji jest już oznaczone. Tu zostaje samo wygaszenie akcji. */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Każdy wpis godzin należy do działu. W dziale obiektowym (OFI) wskazuje
          dodatkowo obiekt — posterunek, na którym te godziny przepracowano;
          w pozostałych działach godziny są kosztem ogólnym firmy i nie mapują
          się na kartotekę. Etykietę w Godzinach poprzedza nazwa firmy
          z Administracja → Firma.
        </p>
        {editable && (
          <div className="ml-auto flex max-w-md gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nazwa nowego działu…"
              data-testid="department-new-name"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <Button
              onClick={handleAdd}
              disabled={!newName.trim() || busy}
              data-testid="department-add"
            >
              <Plus className="mr-1 h-4 w-4" />
              Dodaj
            </Button>
          </div>
        )}
        {/* Legenda zakładki — bez `ml-auto`, bo pole „nowy dział” już zabiera
            wolną przestrzeń; dwie automatyczne marginesy dzieliłyby ją po
            połowie i przycisk dodawania odpłynąłby na środek paska. */}
        <KadryHelp tab="dzialy" className={editable ? undefined : "ml-auto"} />
      </div>

      {/* Błąd zapisu w pasku nad tabelą — przy komunikacie widać wiersz,
          którego dotyczy, i da się go skopiować. */}
      {error && (
        <p className="text-sm text-destructive" data-testid="departments-error">
          {error}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className={THEAD_CLS}>
              <tr>
                <Th tip="Etykieta widoczna w Godzinach — z prefiksem nazwy firmy z Administracja → Firma. Edycja zmienia samą nazwę działu, bez prefiksu.">
                  Dział
                </Th>
                <Th
                  tip="Kolejność na listach wyboru — mniejsza liczba jest wyżej (przyjęte skoki co 10, żeby dało się wstawić dział pomiędzy)"
                  className="w-28 text-right"
                >
                  Kolejność
                </Th>
                <Th tip="Kolor pigułki działu — ten sam we wszystkich zakładkach Kadr (Godziny, Pracownicy, Historia). Kliknij kropkę, żeby ustawić; klik w aktualny kolor go zdejmuje.">
                  Kolor
                </Th>
                <Th tip="Sekcja z własną mini-wersją Kadr („Godziny działu”): jej kierownik wpisuje godziny tego działu, nie widząc reszty firmy. Brak portalu = dział wyłącznie dla pełnych Kadr.">
                  Portal
                </Th>
                <Th tip="Dział-pula: jego koszt rozdziela się na wszystkie dozorowane obiekty, zamiast obciążać jednego klienta. Pula może być tylko jedna.">
                  Pula CMA
                </Th>
                <Th tip="Tylko w takim dziale wpis godzin może wskazać obiekt — pracownicy obiektowi (posterunki) należą do jednego działu, w praktyce OFI.">
                  Obiekty
                </Th>
                <Th tip="Nieaktywny dział nie jest podpowiadany przy wpisywaniu godzin (zostaje widoczny na wierszach, które już go używają)">
                  Status
                </Th>
                <Th
                  tip="Suma godzin wypracowanych na tym dziale z całej historii"
                  className="text-right"
                >
                  Godziny
                </Th>
                {/* Dwa liczniki, bo to dwa niezależne przypisania: kartoteka
                    (macierzysty dział osoby — jedyna więź dla biura, które nie
                    księguje godzin) i wpisy godzin (CMA, Techniczny). Jeden
                    licznik z godzin pokazywał Księgowość z 6 osobami jako „—". */}
                <Th
                  tip="Osoby z macierzystym działem w kartotece pracowników. Dla działów biura (Handlowy, Księgowość, Zarząd) to jedyne przypisanie — biuro nie wpisuje godzin."
                  className="text-right"
                >
                  W kartotece
                </Th>
                <Th
                  tip="Ilu różnych pracowników kiedykolwiek księgowało godziny na tym dziale"
                  className="text-right"
                >
                  Z godzin
                </Th>
                <Th className="w-32" />
              </tr>
            </thead>
            <tbody data-testid="departments-table">
              {sorted.length === 0 ? (
                <EmptyRow
                  colSpan={11}
                  loading={loading}
                  icon={Building2}
                  title="Słownik działów jest pusty"
                  description={
                    editable
                      ? "Dodaj pierwszy dział polem obok — potem będzie go można wskazać we wpisie godzin."
                      : "Dział wskazuje się w każdym wpisie godzin. Słownik uzupełnia osoba z prawem edycji Kadr."
                  }
                />
              ) : (
                sorted.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      // `group` — akcje po prawej pokazują się dopiero pod
                      // kursorem (patrz `RowActions`).
                      "group border-b hover:bg-accent/50",
                      !r.active && "text-muted-foreground",
                    )}
                  >
                    <td className="px-3 py-2 font-medium">
                      {renaming?.id === r.id ? (
                        <div className="flex items-center gap-1">
                          {/* Pole trzyma SUROWĄ nazwę, bez prefiksu firmy. */}
                          <Input
                            autoFocus
                            className="h-8 max-w-sm"
                            value={renaming.value}
                            data-testid="department-rename-input"
                            onChange={(e) =>
                              setRenaming({ id: r.id, value: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenaming(null);
                              }
                            }}
                            onBlur={() => void commitRename()}
                          />
                          {/* Akcje trybu edycji są widoczne zawsze (nie
                              `RowActions`) — pole jest otwarte, więc to jedyne
                              wyjście. `onMouseDown` z `preventDefault` chroni
                              je przed `onBlur` pola. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn("h-8 w-8", TEXT_TONE.good)}
                            aria-label="Zapisz nazwę"
                            {...tip("Zapisz nazwę")}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => void commitRename()}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Anuluj zmianę nazwy"
                            {...tip("Anuluj zmianę nazwy")}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setRenaming(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        /* Etykieta z prefiksem — użytkownik ma tu widzieć
                           dokładnie to, co zobaczy w selekcie Godzin; pigułka
                           w kolorze działu, tak jak w Godzinach i kartotece. */
                        <KadryBadge tone={departmentTone(r)}>
                          {r.label || r.name}
                        </KadryBadge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        className="ml-auto h-8 w-20 text-right tabular-nums"
                        inputMode="numeric"
                        defaultValue={String(r.sortOrder)}
                        disabled={!editable}
                        aria-label={`Kolejność działu ${r.name}`}
                        key={`${r.id}:${r.sortOrder}`}
                        onBlur={(e) => handleOrder(r, e.currentTarget.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && e.currentTarget.blur()
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      {/* Paleta w wierszu, nie w dialogu: dziewięć kropek mieści
                          się w kolumnie, a wybór widać od razu na pigułce działu
                          w kolumnie obok. */}
                      <div className="flex flex-wrap items-center gap-1">
                        {DEPARTMENT_COLOR_TONES.map((tone) => {
                          const activeTone = r.color === tone;
                          return (
                            <button
                              key={tone}
                              type="button"
                              aria-label={`Kolor działu: ${TONE_LABELS[tone] ?? tone}`}
                              aria-pressed={activeTone}
                              data-testid={`department-color-${r.id}-${tone}`}
                              onClick={
                                editable && !busy
                                  ? () => handleColor(r, tone)
                                  : undefined
                              }
                              {...tip(
                                activeTone
                                  ? `Kolor ${TONE_LABELS[tone] ?? tone} — kliknij, żeby zdjąć`
                                  : `Ustaw kolor: ${TONE_LABELS[tone] ?? tone}`,
                              )}
                              className={cn(
                                "h-4 w-4 rounded-full border transition-transform",
                                PILL_TONE[tone],
                                activeTone
                                  ? "scale-110 border-foreground"
                                  : "border-transparent hover:scale-110",
                                (!editable || busy) && "cursor-default",
                              )}
                            />
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className={cn(TABLE_SELECT_CLS, "h-8 w-[130px]")}
                        value={r.portal ?? ""}
                        disabled={!editable || busy}
                        aria-label={`Portal działu ${r.name}`}
                        data-testid={`department-portal-${r.id}`}
                        onChange={(e) => handlePortal(r, e.target.value)}
                      >
                        <option value="">— brak —</option>
                        {DEPARTMENT_PORTALS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <KadryBadge
                        tone={r.isCmaPool ? "pula" : "nieaktywny"}
                        onClick={() => handleTogglePool(r)}
                        disabled={!editable || busy}
                        hint={
                          denied[denyKey(r.id, "pool")] ??
                          (r.isCmaPool
                            ? "Koszt tego działu rozdziela się na wszystkie dozorowane obiekty. Kliknij, żeby zdjąć znacznik puli."
                            : r.hasObjects
                              ? "Dział obiektowy nie może być pulą CMA — godziny puli rozdzielają się na wszystkie obiekty, więc nie wskazują żadnego."
                              : "Zwykły dział — koszt zostaje kosztem ogólnym firmy. Kliknij, żeby uczynić go pulą CMA (może być tylko jedna).")
                        }
                      >
                        {r.isCmaPool ? "pula CMA" : "zwykły"}
                      </KadryBadge>
                    </td>
                    <td className="px-3 py-2">
                      <KadryBadge
                        tone={r.hasObjects ? "info" : "nieaktywny"}
                        onClick={() => handleToggleObjects(r)}
                        disabled={!editable || busy}
                        testId={`department-objects-${r.id}`}
                        hint={
                          denied[denyKey(r.id, "objects")] ??
                          (r.hasObjects
                            ? "Tylko w takim dziale wpis godzin może wskazać obiekt. Kliknij, żeby zdjąć znacznik (odmowa, jeśli wiszą tu wpisy z obiektem)."
                            : r.isCmaPool
                              ? "Dział-pula CMA nie może być obiektowy — jego godziny rozdzielają się na wszystkie obiekty."
                              : "Tylko w dziale obiektowym wpis godzin może wskazać obiekt. Kliknij, żeby oznaczyć ten dział jako obiektowy.")
                        }
                      >
                        {r.hasObjects ? "obiektowy" : "bez obiektów"}
                      </KadryBadge>
                    </td>
                    <td className="px-3 py-2">
                      <KadryBadge
                        tone={r.active ? "aktywny" : "nieaktywny"}
                        onClick={() => handleToggleActive(r)}
                        disabled={!editable || busy}
                        hint={
                          r.active
                            ? "Dział podpowiadany przy wpisywaniu godzin. Kliknij, żeby go wygasić."
                            : "Dział nie jest podpowiadany przy wpisywaniu godzin (zostaje na wierszach, które już go używają). Kliknij, żeby przywrócić."
                        }
                      >
                        {r.active ? "aktywny" : "nieaktywny"}
                      </KadryBadge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.hoursTotal ? hrs(r.hoursTotal) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.employeesCount || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.hoursEmployeesCount || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <RowActions>
                        {/* Historia działu: odczyt, więc bez bramki `editable`. */}
                        <EntityHistory
                          entityType="hr_department"
                          entityId={r.id}
                          title={r.label ?? r.name}
                          // 32 px jak pozostałe akcje wiersza (`IconButton`) —
                          // w gęstej tabeli Kadr 36 px odstawało.
                          className="h-8 w-8"
                        />
                      {editable && (
                        <>
                          <IconButton
                            icon={Pencil}
                            label="Zmień nazwę działu"
                            testId="department-rename"
                            onClick={() => setRenaming({ id: r.id, value: r.name })}
                          />
                          {/* Pula CMA: kosz wyszarzony, jak reszta akcji przy
                              `!editable` — powód w tooltipie, bo `disabled`
                              nie przepuszcza kliknięcia, które mogłoby go
                              wyświetlić. */}
                          <IconButton
                            icon={Trash2}
                            danger
                            label={
                              r.isCmaPool
                                ? "Działu-puli CMA nie da się usunąć — najpierw przenieś flagę puli na inny dział"
                                : "Usuń dział"
                            }
                            disabled={r.isCmaPool}
                            onClick={() => void handleDelete(r)}
                          />
                        </>
                      )}
                      </RowActions>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {confirm.dialog}
    </>
  );
}
