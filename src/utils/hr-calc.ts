// Kalkulacja wynagrodzeń modułu Kadry.
//
// Przepisana z formuł skoroszytu "MASTER" (arkusz WYNAGRODZENIA), ale wydajnie:
// zamiast SUMIFS/MAXIFS per komórka — jedna agregacja godzin per pracownik
// (buildHoursAggregates) i jeden przebieg po umowach (computePayroll).
//
// Świadome poprawki względem Excela (udokumentowane w tooltipach na froncie):
// 1. Premia/potrącenie NIE ginie, gdy umowa nie ma DODATKU — w Excelu
//    kwota z kolumny U trafiała do wypłaty tylko kanałem dodatku; przy pustym
//    DODATKU przepadała (np. premia 160 zł / potrącenie -206,67 zł w czerwcu).
//    Tutaj: gdy brak dodatku, premia+wyrównanie idą kanałem wypłaty głównej.
// 2. Kanał dodatku to enum (bonusType), nie SEARCH po tekście.
// 3. Premia/potrącenie liczona raz na pracownika (na pierwszej umowie
//    nie-ZZA) — w Excelu formuła per wiersz mogła ją zdublować.

import type { HrContract, HrHours, HrPayroll } from "../db/schema.js";

export interface HoursAggregate {
  worked: number; // suma godzin wypracowanych
  uw: number; // suma godzin UW
  l4: number; // suma godzin L4
  night: number; // suma godzin nocnych (informacyjne)
  maxHours: number | null; // max z GODZINY MAKS (null = brak wpisu)
  deductions: number; // suma potrąceń (zł)
  bonuses: number; // suma dodatków/premii (zł)
  entryCount: number; // liczba wpisów godzin w miesiącu
}

export interface PayrollComputed {
  contractId: number;
  employeeId: number;
  registration: "zua" | "zza" | null; // które zgłoszenie decyduje o gałęzi
  maxHoursSource: "override" | "individual" | "norm";
  maksGodziny: number; // limit godzin
  faktGodziny: number | null; // godziny do rozliczenia (null = brak ZUA/ZZA)
  godzinyDodatek: number; // nadwyżka ponad maks (tylko gdy umowa ma dodatek)
  stawkaNetto: number | null; // kwota główna / fakt godziny
  kwotaGlowna: number | null; // od księgowości (wejście)
  kwotaWyrownania: number | null; // wyrównanie stawki × fakt godziny
  kwotaDodatku: number | null; // godziny dodatku × stawka dodatku (lub główna)
  bonusPending: boolean; // "do przeliczenia" — brak stawki dodatku
  premiaPotracenie: number | null; // suma DODATKI − POTRĄCENIA z godzin
  dodatekFinalny: number | null; // kwota dodatku + premia + wyrównanie
  przelew: number; // część wypłaty na przelew
  gotowka: number; // część wypłaty gotówką
  wyplata: number; // przelew + gotówka
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Agreguje wpisy godzin miesiąca do mapy employeeId → HoursAggregate. */
export function buildHoursAggregates(
  rows: HrHours[],
): Map<number, HoursAggregate> {
  const map = new Map<number, HoursAggregate>();
  for (const r of rows) {
    let agg = map.get(r.employeeId);
    if (!agg) {
      agg = {
        worked: 0,
        uw: 0,
        l4: 0,
        night: 0,
        maxHours: null,
        deductions: 0,
        bonuses: 0,
        entryCount: 0,
      };
      map.set(r.employeeId, agg);
    }
    agg.worked += r.workedHours ?? 0;
    agg.uw += r.uwHours ?? 0;
    agg.l4 += r.l4Hours ?? 0;
    agg.night += r.nightHours ?? 0;
    if (r.maxHours != null) {
      agg.maxHours =
        agg.maxHours == null ? r.maxHours : Math.max(agg.maxHours, r.maxHours);
    }
    agg.deductions += r.deductions ?? 0;
    agg.bonuses += r.bonuses ?? 0;
    agg.entryCount += 1;
  }
  return map;
}

export interface PayrollInput {
  contracts: HrContract[]; // aktywne umowy
  payrollByContract: Map<number, HrPayroll>; // wejścia miesięczne per umowa
  hoursByEmployee: Map<number, HoursAggregate>;
  workNorm: number; // norma godzin UoP w miesiącu
  contractNorm: number; // norma godzin zlecenia
}

/** Liczy pełny miesiąc wynagrodzeń — jeden przebieg po umowach. */
export function computePayroll(input: PayrollInput): PayrollComputed[] {
  const { contracts, payrollByContract, hoursByEmployee } = input;

  // Cross-kontraktowe zależności liczone raz, nie per wiersz:
  // - czy pracownik ma jakąkolwiek umowę o pracę (gałąź ZZA odejmuje wtedy normę UoP)
  // - pierwsza umowa nie-ZZA pracownika (na niej ląduje premia/potrącenie)
  const hasPraca = new Set<number>();
  const premiaContract = new Map<number, number>(); // employeeId → contractId
  for (const c of contracts) {
    if (c.contractType === "praca") hasPraca.add(c.employeeId);
    const isZza = !c.zua.trim() && !!c.zza.trim();
    if (!isZza && !premiaContract.has(c.employeeId)) {
      premiaContract.set(c.employeeId, c.id);
    }
  }

  return contracts.map((c) => {
    const p = payrollByContract.get(c.id);
    const agg = hoursByEmployee.get(c.employeeId);
    const warnings: string[] = [];

    const norm =
      c.contractType === "praca" ? input.workNorm : input.contractNorm;

    // --- maks godziny: override > indywidualny limit (UoP) > norma miesiąca
    let maksGodziny: number;
    let maxHoursSource: PayrollComputed["maxHoursSource"];
    if (p?.maxHoursOverride != null) {
      maksGodziny = p.maxHoursOverride;
      maxHoursSource = "override";
    } else if (c.contractType === "praca" && agg?.maxHours != null) {
      maksGodziny = agg.maxHours;
      maxHoursSource = "individual";
    } else {
      maksGodziny = norm;
      maxHoursSource = "norm";
    }

    // --- godziny bazowe: wypracowane + UW (+ L4 przy umowie o pracę)
    const worked = agg?.worked ?? 0;
    const uw = agg?.uw ?? 0;
    const l4 = agg?.l4 ?? 0;
    const baseHours = worked + uw + (c.contractType === "praca" ? l4 : 0);

    // --- rejestracja: ZUA (umowa główna) czy ZZA (nadwyżka w innej spółce)
    const registration: PayrollComputed["registration"] = c.zua.trim()
      ? "zua"
      : c.zza.trim()
        ? "zza"
        : null;
    if (!registration) warnings.push("Brak ZUA/ZZA — godziny nierozliczane");

    // --- fakt godziny
    let faktGodziny: number | null = null;
    if (p?.actualHoursOverride != null) {
      faktGodziny = p.actualHoursOverride;
    } else if (registration === "zua") {
      // umowa główna: godziny capowane do maks
      faktGodziny = Math.min(Math.max(0, baseHours), maksGodziny);
    } else if (registration === "zza") {
      // ZZA dostaje nadwyżkę ponad normę umowy głównej: jeśli pracownik ma
      // gdziekolwiek UoP — ponad normę UoP, inaczej ponad maks tego wiersza
      const threshold = hasPraca.has(c.employeeId)
        ? input.workNorm
        : maksGodziny;
      faktGodziny = Math.max(0, baseHours - threshold);
    }

    // --- godziny dodatku: nadwyżka ponad maks (tylko gdy umowa ma dodatek).
    // L4 wlicza się do nadwyżki przy UoP oraz przy zleceniu w spółce ALFA
    // (reguła przeniesiona wprost z arkusza).
    let godzinyDodatek = 0;
    if (c.bonusType !== "brak" && agg && agg.entryCount > 0) {
      const l4Counts =
        c.contractType === "praca" ||
        (c.company === "ALFA" && c.contractType === "zlecenie");
      godzinyDodatek = Math.max(
        0,
        worked + uw + (l4Counts ? l4 : 0) - maksGodziny,
      );
    }

    // --- kwoty
    const kwotaGlowna = p?.mainAmount ?? null;
    const stawkaNetto =
      kwotaGlowna != null && faktGodziny ? kwotaGlowna / faktGodziny : null;

    const kwotaWyrownania =
      p?.rateAdjustment != null && faktGodziny != null
        ? round2(p.rateAdjustment * faktGodziny)
        : null;

    // kwota dodatku: ręczna > godziny dodatku × (stawka dodatku lub główna)
    let kwotaDodatku: number | null = null;
    let bonusPending = false;
    if (p?.bonusAmountOverride != null) {
      kwotaDodatku = p.bonusAmountOverride;
    } else if (godzinyDodatek > 0) {
      const rate = p?.bonusRate ?? stawkaNetto;
      if (p?.bonusRatePending || rate == null) {
        bonusPending = true;
        warnings.push("Dodatek do przeliczenia — brak stawki");
      } else {
        kwotaDodatku = round2(godzinyDodatek * rate);
      }
    }

    // --- premia/potrącenie (zł) — raz na pracownika, na pierwszej umowie nie-ZZA
    let premiaPotracenie: number | null = null;
    if (premiaContract.get(c.employeeId) === c.id && agg) {
      const diff = agg.bonuses - agg.deductions;
      if (diff !== 0) premiaPotracenie = round2(diff);
    }

    // --- dodatek finalny = kwota dodatku + premia/potrącenie + wyrównanie
    const finalParts = [kwotaDodatku, premiaPotracenie, kwotaWyrownania];
    const dodatekFinalny = finalParts.every((v) => v == null)
      ? null
      : round2(finalParts.reduce((s: number, v) => s + (v ?? 0), 0));

    // --- rozbicie na kanały wypłaty
    const bonusChannel: "przelew" | "gotowka" | null =
      c.bonusType === "delegacja_przelew"
        ? "przelew"
        : c.bonusType === "gotowka" || c.bonusType === "delegacja_gotowka"
          ? "gotowka"
          : null;

    let przelew = 0;
    let gotowka = 0;
    if (kwotaGlowna != null) {
      if (c.mainChannel === "przelew") przelew += kwotaGlowna;
      else gotowka += kwotaGlowna;
    }
    if (dodatekFinalny != null) {
      // dodatek idzie swoim kanałem; bez dodatku — kanałem wypłaty głównej
      // (poprawka względem Excela: tam premia bez DODATKU przepadała)
      const channel = bonusChannel ?? c.mainChannel;
      if (channel === "przelew") przelew += dodatekFinalny;
      else gotowka += dodatekFinalny;
    }

    return {
      contractId: c.id,
      employeeId: c.employeeId,
      registration,
      maxHoursSource,
      maksGodziny,
      faktGodziny,
      godzinyDodatek: round2(godzinyDodatek),
      stawkaNetto: stawkaNetto != null ? round2(stawkaNetto) : null,
      kwotaGlowna,
      kwotaWyrownania,
      kwotaDodatku,
      bonusPending,
      premiaPotracenie,
      dodatekFinalny,
      przelew: round2(przelew),
      gotowka: round2(gotowka),
      wyplata: round2(przelew + gotowka),
      warnings,
    };
  });
}
