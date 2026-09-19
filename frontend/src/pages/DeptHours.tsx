/**
 * „GODZINY DZIAŁU” — mini-Kadry jednej sekcji (CMA, OFI, Handlowy, Techniczny).
 *
 * PO CO. Godziny wpisuje ten, kto wie, ile kto przepracował: kierownik CMA za
 * centrum monitorowania, OFI za posterunki, dział handlowy i techniczny za
 * siebie. Dotąd jedynym miejscem były pełne Kadry — a tam widać wypłaty,
 * kartotekę i kwoty wszystkich, więc klucza nie dawało się nikomu dać. Ten
 * ekran to ta sama tabela godzin, przycięta do JEDNEJ sekcji: bez wypłat, bez
 * kartoteki, bez norm i bez słowników do edycji.
 *
 * CO ZAWĘŻA DANE. Nie ten plik: backend (`src/lib/hr-scope.ts`) dostaje
 * `?portal=` przy każdym żądaniu i sam odcina wiersze, działy, posterunki
 * i ludzi spoza sekcji. Front pokazuje to, co dostał — inaczej wystarczyłoby
 * otworzyć konsolę, żeby zobaczyć całą firmę.
 *
 * CZEGO TU NIE MA I DLACZEGO:
 *  - kafli wynagrodzeń i listy płac — to nie jest ekran o pieniądzach
 *    (potrącenia i dodatki zostają: wpisuje je kierownik razem z godzinami),
 *  - zamykania miesiąca — pasek stanu jest tylko do odczytu; zamknięty miesiąc
 *    przełącza ekran w podgląd, a decyzję podejmuje księgowość w Kadrach,
 *  - globalnego dziennika zmian — zostaje historia WPISU i historia godzin
 *    pracownika, obie zawężone do sekcji.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { HrHoursForm } from "@/components/KadryForms";
import { HrHoursTab } from "@/components/kadry/HoursTab";
import { MonthNav } from "@/components/kadry/MonthNav";
import { MonthStatusBar } from "@/components/kadry/MonthStatusBar";
import { PortalEmployeeHistory } from "@/components/kadry/PortalEmployeeHistory";
import { useConfirm } from "@/components/kadry/useConfirm";
import { useEditLock } from "@/components/kadry/useEditLock";
import { hrChangeHitsMonth, useHrLive } from "@/lib/hrLive";
import { hrs, MONTH_NAMES } from "@/components/kadry/shared";
import { KadryBadge, departmentTone } from "@/components/kadry/ui";
import { KadryHelp } from "@/components/kadry/KadryHelp";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  createHrHours,
  deleteHrHours,
  getHrDepartments,
  getHrEmployeeDirectory,
  getHrHours,
  getHrMonthStatus,
  getHrObjects,
  updateHrHours,
  type HrDepartment,
  type HrEmployee,
  type HrHoursEntry,
  type HrHoursInput,
  type HrMonthStatus,
  type HrObject,
  type HrPortalKey,
} from "@/lib/api";

/** Klucz uprawnień podzakładki — lustro `PORTAL_HOURS_TAB` z backendu. */
const PORTAL_TAB: Record<HrPortalKey, string> = {
  cma: "cma/godziny",
  ofi: "ofi/godziny",
  handlowy: "handlowy/godziny",
  technical: "technical/godziny",
};

/** Nazwa sekcji w nagłówku — ta sama, co pozycja w menu bocznym. */
const PORTAL_TITLE: Record<HrPortalKey, string> = {
  cma: "CMA",
  ofi: "OFI",
  handlowy: "Handlowy",
  technical: "Techniczny",
};

export function DeptHours({ portal }: { portal: HrPortalKey }) {
  const { canEdit } = usePerms();
  const tabKey = PORTAL_TAB[portal];
  const hasEdit = canEdit(tabKey);

  /**
   * Miesiąc siedzi w adresie (`?m=2026-09`) — tak samo jak w Kadrach, żeby link
   * „zobacz sierpień” otwierał u drugiej osoby sierpień, a nie bieżący miesiąc.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const now = new Date();
  const parsed = /^(\d{4})-(\d{1,2})$/.exec(searchParams.get("m") ?? "");
  const validMonth = parsed && Number(parsed[2]) >= 1 && Number(parsed[2]) <= 12;
  const year = validMonth ? Number(parsed[1]) : now.getFullYear();
  const month = validMonth ? Number(parsed[2]) : now.getMonth() + 1;

  const setYearMonth = useCallback(
    (y: number, m: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("m", `${y}-${String(m).padStart(2, "0")}`);
      // `replace`: przewijanie miesięcy nie ma zapychać historii przeglądarki.
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const [rows, setRows] = useState<HrHoursEntry[]>([]);
  const [departments, setDepartments] = useState<HrDepartment[]>([]);
  const [objects, setObjects] = useState<HrObject[]>([]);
  const [directory, setDirectory] = useState<
    { id: number; fullName: string; kind: "ochrona" | "biuro"; active: boolean; code?: string }[]
  >([]);
  const [monthStatus, setMonthStatus] = useState<HrMonthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editRow, setEditRow] = useState<HrHoursEntry | null>(null);
  const confirm = useConfirm();

  /**
   * Rezerwacja listy godzin W IMIENIU SEKCJI: portal blokuje wyłącznie wiersze
   * swoich działów, więc OFI i CMA wypełniają miesiąc równolegle, a pełne Kadry
   * dostają resztę listy (src/lib/hr-locks.ts).
   */
  const lock = useEditLock({ scope: "hours", year, month, enabled: hasEdit, portal });
  const lockRef = useRef(lock);
  useEffect(() => {
    lockRef.current = lock;
  });

  const monthKeyRef = useRef("");
  const loadMonth = useCallback(
    async (opts?: { silent?: boolean }) => {
      const key = `${portal}:${year}-${month}`;
      monthKeyRef.current = key;
      if (!opts?.silent) setLoading(true);
      try {
        const [h, st] = await Promise.all([
          getHrHours(year, month, portal),
          getHrMonthStatus(year, month),
        ]);
        if (monthKeyRef.current !== key) return; // zmieniono miesiąc w trakcie
        setRows(h.data ?? []);
        setMonthStatus(st.data ?? null);
        setError(null);
      } catch (e) {
        if (monthKeyRef.current !== key) return;
        setError(e instanceof Error ? e.message : "Nie udało się wczytać godzin");
      } finally {
        if (monthKeyRef.current === key && !opts?.silent) setLoading(false);
      }
    },
    [portal, year, month],
  );

  const loadDictionaries = useCallback(async () => {
    const [d, o, e] = await Promise.all([
      getHrDepartments(false, portal),
      getHrObjects(false, portal),
      getHrEmployeeDirectory(false, portal),
    ]);
    setDepartments(d.data ?? []);
    setObjects(o.data ?? []);
    setDirectory(e.data ?? []);
  }, [portal]);

  useEffect(() => {
    void loadMonth();
  }, [loadMonth]);
  useEffect(() => {
    void loadDictionaries();
  }, [loadDictionaries]);

  /**
   * NA ŻYWO. Sygnał z `/api/hr/live` mówi tylko „coś się zmieniło” — dane
   * dociągamy zwykłym zapytaniem z `?portal=`, więc uprawnień pilnuje backend.
   * Sygnał nie niesie sekcji, ale zawężony odczyt i tak odda wyłącznie nasze
   * wiersze; najgorszym skutkiem cudzej zmiany jest jedno zbędne odświeżenie.
   */
  const liveRef = useRef<number | null>(null);
  useHrLive((change) => {
    if (change.scope === "locks") return; // stan rezerwacji ogarnia `useEditLock`
    if (!hrChangeHitsMonth(change, year, month)) return;
    if (liveRef.current) window.clearTimeout(liveRef.current);
    liveRef.current = window.setTimeout(() => {
      liveRef.current = null;
      void loadMonth({ silent: true });
      if (change.scope === "dictionary" || change.resync) void loadDictionaries();
    }, 300);
  });
  useEffect(
    () => () => {
      if (liveRef.current) window.clearTimeout(liveRef.current);
    },
    [],
  );

  /**
   * Zamknięty miesiąc = tryb tylko do odczytu, tak samo jak w Kadrach. Powód
   * mówi pasek `MonthStatusBar` nad tabelą (tutaj bez przycisków: zamknięcie
   * i otwarcie to decyzja o CAŁYM miesiącu wypłat, więc zostaje w Kadrach).
   */
  const monthClosed = monthStatus?.status === "closed";
  const editable = hasEdit && !monthClosed;

  /**
   * Sekcja z JEDNYM działem nie pyta o dział — kolumna, filtr i select znikają,
   * a nowy wpis dostaje go automatycznie. Dwa działy ma dziś tylko OFI (OFI
   * i Operacyjny), więc tam wszystko zostaje po staremu.
   */
  const soleDepartment = departments.length === 1 ? departments[0] : null;
  const showDepartment = departments.length > 1;
  // Posterunki istnieją wyłącznie w dziale obiektowym — backend oddaje sekcji
  // bez niego pustą listę, więc pusta lista jest tu jednoznaczna.
  const showObject = objects.length > 0;

  /**
   * Pracownicy do formularza. Katalog sekcji (`/hr/directory/employees`) niesie
   * sam identyfikator, nazwisko i kod — kartoteki sekcja nie dostaje. Resztę
   * pól `HrEmployee` dopełniamy pustymi wartościami; jedyne, co formularz z nich
   * czyta, to `departmentId` (podpowiedź działu) i `kind`. Dział podstawiamy
   * TYLKO tam, gdzie jest jednoznaczny — w OFI wybiera go człowiek.
   */
  const formEmployees = useMemo<HrEmployee[]>(
    () =>
      directory.map((e) => ({
        id: e.id,
        fullName: e.fullName,
        code: e.code ?? "",
        kind: e.kind,
        departmentId: soleDepartment?.id ?? null,
        departmentName: soleDepartment?.label ?? "",
        active: e.active,
        notes: "",
        createdAt: "",
        updatedAt: "",
      })),
    [directory, soleDepartment],
  );

  const handleSubmit = async (data: HrHoursInput) => {
    if (!editable) return;
    if (!(await lock.ensure())) return;
    // Sekcja z jednym działem nie ma pola „Dział” — podstawiamy go tutaj,
    // zamiast pokazywać select z jedną pozycją.
    const payload: HrHoursInput =
      soleDepartment && data.departmentId == null
        ? { ...data, departmentId: soleDepartment.id }
        : data;
    if (editRow) await updateHrHours(editRow.id, payload, portal);
    else await createHrHours(payload, portal);
    await loadMonth();
  };

  /** Wiersz zapisany inline — podmieniamy go na miejscu, etykiety z ekranu. */
  const handleRowSaved = (id: number, saved: HrHoursEntry) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              ...saved,
              employeeName: r.employeeName,
              objectName: objects.find((o) => o.id === saved.objectId)?.name ?? "",
              departmentName:
                departments.find((d) => d.id === saved.departmentId)?.label ?? "",
            }
          : r,
      ),
    );
  };

  const handleDelete = (row: HrHoursEntry) => {
    if (!editable) return;
    confirm.ask({
      title: `Usunąć wpis godzin: ${row.employeeName}?`,
      description: "Wpis zniknie z miesiąca, a jego godziny przestaną wchodzić do wynagrodzeń.",
      onConfirm: async () => {
        if (!(await lock.ensure())) return;
        await deleteHrHours(row.id, portal);
        await loadMonth();
      },
    });
  };

  /**
   * Pusty miesiąc bez automatu: pełne Kadry przenoszą wiersze z poprzedniego
   * miesiąca same przy wejściu, ale w sekcji zrobiłyby to CZTERY ekrany naraz,
   * każdy biorąc rezerwację. Tutaj zostaje przycisk w `HrHoursTab` — jedno
   * świadome kliknięcie tego, kto akurat wypełnia miesiąc.
   */
  const totalHours = rows.reduce(
    (s, r) => s + (r.workedHours ?? 0) + (r.uwHours ?? 0) + (r.l4Hours ?? 0),
    0,
  );

  return (
    <div className="space-y-3">
      {!hasEdit && <ReadOnlyBanner className="mb-4" />}

      {/* Pasek sekcji: czyja to lista, za jaki miesiąc i ile w niej jest.
          Zamiast sześciu kafli wynagrodzeń — jedno zdanie, bo ten ekran
          odpowiada na jedno pytanie: „czy godziny są już wpisane”. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
          <span className="font-medium">Godziny działu</span>
          {departments.length > 0 ? (
            departments.map((d) => (
              <KadryBadge key={d.id} tone={departmentTone(d)}>
                {d.label}
              </KadryBadge>
            ))
          ) : (
            <KadryBadge tone="ostrzezenie">
              {PORTAL_TITLE[portal]} — brak działu z tym portalem
            </KadryBadge>
          )}
          <span className="text-muted-foreground">
            {MONTH_NAMES[month - 1]} {year} · {rows.length}{" "}
            {rows.length === 1 ? "wpis" : "wpisów"} · {hrs(totalHours)} h
          </span>
          {/* Legenda sekcji — ta sama pomoc co w Kadrach, z zestawem sekcji dla
              ekranu bez wypłat i bez słowników. */}
          <KadryHelp tab="portal" className="ml-auto" />
        </CardContent>
      </Card>

      {/*
        Stan miesiąca — TYLKO do odczytu (`canClose={false}`): zamknięcie dotyczy
        całej firmy, nie jednej sekcji.

        I TYLKO PO ZAMKNIĘCIU. Pasek otwartego miesiąca to lista kontrolna CAŁEJ
        firmy („kwoty 120 z 147 umów”, „biuro 12 wpisów”) — liczby o wypłatach,
        których sekcja nie ma prawa znać i o których nic nie może zrobić. Po
        zamknięciu zostaje jedno zdanie: dlaczego ekran jest w podglądzie.
      */}
      {monthClosed && (
        <MonthStatusBar
          status={monthStatus}
          year={year}
          month={month}
          canClose={false}
          onChanged={() => void loadMonth()}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <HrHoursTab
        rows={rows}
        objects={objects}
        departments={departments}
        editable={editable}
        lock={lock}
        loading={loading}
        monthNav={<MonthNav year={year} month={month} onChange={setYearMonth} />}
        year={year}
        month={month}
        portal={portal}
        showDepartment={showDepartment}
        showObject={showObject}
        rowExtras={(r) => (
          <PortalEmployeeHistory
            employeeId={r.employeeId}
            employeeName={r.employeeName}
            portal={portal}
          />
        )}
        onRowSaved={handleRowSaved}
        onChanged={() => void loadMonth()}
        onAdd={() => {
          setEditRow(null);
          setFormOpen(true);
        }}
        onEdit={(row) => {
          setEditRow(row);
          setFormOpen(true);
        }}
        onDelete={handleDelete}
      />

      {formOpen && (
        <HrHoursForm
          key={editRow?.id ?? "new"}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
          entry={editRow}
          employees={
            editRow ? formEmployees : formEmployees.filter((e) => e.active)
          }
          objects={objects.filter((o) => o.active || o.id === editRow?.objectId)}
          departments={departments.filter(
            (d) => d.active || d.id === editRow?.departmentId,
          )}
          year={year}
          month={month}
        />
      )}
      {confirm.dialog}
    </div>
  );
}
