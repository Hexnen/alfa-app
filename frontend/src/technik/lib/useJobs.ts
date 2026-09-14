import { useCallback, useEffect, useRef, useState } from "react";
import { technikApi, type TechnikJob } from "@/lib/api";
import { useRefreshOnFocus } from "./refresh";
import { hitsAny, useLiveReload } from "./live";

/**
 * DANE PANELU BEZ REACT QUERY.
 *
 * Alfa nie ma React Query, a panel technika to trzy ekrany i cztery zapytania —
 * własny cache byłby tu większy od problemu. Wystarczy `useState` + świadome
 * odświeżenie: po powrocie do karty i po każdej akcji (`reload()`).
 *
 * `seq` chroni przed wyścigiem: przy szybkim przerzucaniu dni odpowiedź na
 * starsze zapytanie potrafi przyjść później niż na nowsze i podmieniłaby
 * listę na dzień, którego technik już nie ogląda.
 */
export interface JobsState {
  jobs: TechnikJob[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useJobs(from: string, to: string): JobsState {
  const [jobs, setJobs] = useState<TechnikJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  /**
   * Zmiana zakresu czyści listę JESZCZE PRZED pierwszym renderem nowego dnia.
   *
   * Wcześniej po tapnięciu „Następny dzień” nagłówek pokazywał już jutro,
   * a pod nim przez sekundę stały wczorajsze zlecenia — bez żadnego znaku, że
   * to stare dane. Technik zdążył na nie kliknąć. Poprawka stanu w trakcie
   * renderu (zamiast efektu) jest tu świadoma: React przerywa render i robi go
   * od nowa z pustą listą, więc stary dzień nie mignie ani na klatkę.
   */
  const rangeKey = `${from}|${to}`;
  const [range, setRange] = useState(rangeKey);
  if (range !== rangeKey) {
    setRange(rangeKey);
    setJobs([]);
    setError(null);
    setLoading(true);
  }

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const data = await technikApi.jobs(from, to);
      if (my !== seq.current) return;
      setJobs(data);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(e instanceof Error ? e.message : "Nie udało się wczytać zleceń.");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshOnFocus(() => void load());

  /**
   * Sygnał z biura (`lib/live.ts`) — backend przysyła WYŁĄCZNIE zmiany zleceń tego
   * technika, więc lista przeładowuje się po każdej z nich. Świadomie nie sprawdzamy
   * tu, czy id leży na bieżącej liście: przesunięty termin wskakuje na dzisiejszy
   * dzień z innej daty, a świeże przypisanie dokłada zlecenie, którego na liście
   * jeszcze nie było — filtr po widocznych id przespałby oba przypadki.
   *
   * Wyjątkiem są notatki: notatka przy zleceniu spoza widocznego zakresu niczego
   * na tej liście nie zmienia (`notesCount` dotyczy pozycji, które widać).
   */
  const jobIds = jobs.map((j) => j.id);
  useLiveReload(
    () => void load(),
    (change) => change.kind !== "notes" || hitsAny(change, jobIds),
  );

  return { jobs, loading, error, reload: () => void load() };
}

