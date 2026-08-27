import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { adminAssistantApi, type AdminAssistantTurns, type AdminAssistantUsage } from "@/lib/api";
import { ErrorBox, Tile } from "./shared";
import { errMsg, fmtDateTime, fmtInt, fmtUsd } from "./helpers";

export type UsageDays = 7 | 30 | 90;
const TURNS_PAGE_SIZE = 25;

/** Karta „Zużycie”: statystyki, wykres, top użytkownicy/modele, ostatnie tury, czyszczenie czatów. Własny stan. */
export function UsageSection({ onNotice, onError }: { onNotice: (msg: string) => void; onError: (msg: string) => void }) {
  const [usageDays, setUsageDays] = useState<UsageDays>(30);
  const [usage, setUsage] = useState<AdminAssistantUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [turns, setTurns] = useState<AdminAssistantTurns | null>(null);
  const [turnsPage, setTurnsPage] = useState(1);
  const [turnsError, setTurnsError] = useState<string | null>(null);
  const [confirmClearChats, setConfirmClearChats] = useState(false);
  const [clearingChats, setClearingChats] = useState(false);

  const loadTurns = useCallback(async (days: UsageDays, page: number) => {
    setTurnsError(null);
    try {
      setTurns(await adminAssistantApi.turns({ days, page, pageSize: TURNS_PAGE_SIZE }));
    } catch (e) {
      setTurns(null);
      setTurnsError(errMsg(e, "Nie udało się pobrać listy tur"));
    }
  }, []);

  // Zmiana zakresu dni: przeładuj statystyki i wróć na 1. stronę tur (reset w handlerze, nie w efekcie).
  const changeDays = (d: UsageDays) => {
    setUsageDays(d);
    setTurnsPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setUsageError(null);
    adminAssistantApi
      .usage(usageDays)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch((e) => {
        if (cancelled) return;
        setUsage(null);
        setUsageError(errMsg(e, "Nie udało się pobrać zużycia"));
      });
    return () => {
      cancelled = true;
    };
  }, [usageDays]);

  useEffect(() => {
    void loadTurns(usageDays, turnsPage);
  }, [usageDays, turnsPage, loadTurns]);

  const clearChats = async () => {
    setClearingChats(true);
    try {
      const r = await adminAssistantApi.deleteAllChats();
      onNotice(`Usunięto czaty: ${r.deleted}.`);
      setTurnsPage(1);
      void loadTurns(usageDays, 1);
    } catch (e) {
      onError(errMsg(e, "Nie udało się wyczyścić czatów"));
    } finally {
      setClearingChats(false);
      setConfirmClearChats(false);
    }
  };

  const lastPage = turns ? Math.max(1, Math.ceil(turns.total / turns.pageSize)) : 1;

  return (
    <Card id="zuzycie" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">Zużycie</CardTitle>
          <CardDescription>Tury, tokeny i szacowany koszt na podstawie cennika OpenRouter.</CardDescription>
        </div>
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Zakres dni">
          {([7, 30, 90] as UsageDays[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={usageDays === d}
              onClick={() => changeDays(d)}
              className={cn("rounded px-3 py-1 text-xs font-medium transition-colors", usageDays === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
            >
              {d} dni
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {usageError && <ErrorBox>{usageError}</ErrorBox>}
        {usage && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Tury" value={fmtInt(usage.turns)} sub={`${fmtInt(usage.toolCalls)} wywołań narzędzi`} />
              <Tile label="Tokeny prompt / completion" value={`${fmtInt(usage.promptTokens)} / ${fmtInt(usage.completionTokens)}`} sub={usage.reasoningTokens ? `+ ${fmtInt(usage.reasoningTokens)} reasoning` : undefined} />
              <Tile label="Śr. czas tury" value={`${(usage.avgMs / 1000).toFixed(1)} s`} />
              <Tile
                label="Szacowany koszt"
                value={fmtUsd(usage.estimatedCostUsd, 3)}
                sub={usage.estimatedCostUsd != null && usage.costCoverage < 1 ? `pokrycie cennikiem ${Math.round(usage.costCoverage * 100)}% tur` : undefined}
              />
            </div>

            <DailyChart daily={usage.daily} days={usage.days} />

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <h3 className="text-sm font-semibold">Najaktywniejsi użytkownicy</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Użytkownik</TableHead>
                        <TableHead className="text-right">Tury</TableHead>
                        <TableHead className="text-right">Prompt</TableHead>
                        <TableHead className="text-right">Completion</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.topUsers.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">
                            Brak danych.
                          </TableCell>
                        </TableRow>
                      )}
                      {usage.topUsers.map((u) => (
                        <TableRow key={u.userId}>
                          <TableCell className="max-w-[200px] truncate">{u.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(u.turns)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(u.promptTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(u.completionTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <h3 className="text-sm font-semibold">Według modelu</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Tury</TableHead>
                        <TableHead className="text-right">Tokeny</TableHead>
                        <TableHead className="text-right">Koszt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.byModel.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">
                            Brak danych.
                          </TableCell>
                        </TableRow>
                      )}
                      {usage.byModel.map((m) => (
                        <TableRow key={m.model}>
                          <TableCell className="max-w-[220px] truncate font-mono text-xs">{m.model}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(m.turns)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(m.promptTokens + m.completionTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtUsd(m.costUsd)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Ostatnie tury */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Ostatnie tury{turns ? ` (${fmtInt(turns.total)})` : ""}</h3>
            <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setConfirmClearChats(true)} disabled={clearingChats}>
              <Trash2 className="mr-1 h-4 w-4" /> Wyczyść wszystkie czaty
            </Button>
          </div>
          {turnsError && <ErrorBox>{turnsError}</ErrorBox>}
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kiedy</TableHead>
                  <TableHead>Użytkownik</TableHead>
                  <TableHead>Czat</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokeny</TableHead>
                  <TableHead className="text-right">Koszt</TableHead>
                  <TableHead className="text-right">Czas</TableHead>
                  <TableHead className="text-right">Kroki / narz.</TableHead>
                  <TableHead>Zakończenie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!turns || turns.items.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground">
                      {turns ? "Brak tur w wybranym okresie." : "Wczytywanie…"}
                    </TableCell>
                  </TableRow>
                )}
                {turns?.items.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(t.createdAt)}</TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs">{t.userLabel}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs" title={t.chatTitle ?? undefined}>
                      {t.chatTitle ?? (t.chatId != null ? `#${t.chatId}` : <span className="text-muted-foreground">usunięty</span>)}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate font-mono text-[11px]">{t.model}</TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular-nums" title={`prompt ${fmtInt(t.promptTokens)} · completion ${fmtInt(t.completionTokens)}${t.reasoningTokens ? ` · reasoning ${fmtInt(t.reasoningTokens)}` : ""}`}>
                      {fmtInt(t.promptTokens)} / {fmtInt(t.completionTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtUsd(t.costUsd)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{(t.ms / 1000).toFixed(1)} s</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {t.steps} / {t.toolCalls}
                    </TableCell>
                    <TableCell className="text-xs">{t.finishReason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {turns && turns.total > turns.pageSize && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Strona {turns.page} z {lastPage}
              </span>
              <div className="flex gap-1">
                <Button type="button" variant="outline" size="sm" disabled={turnsPage <= 1} onClick={() => setTurnsPage((p) => p - 1)}>
                  Poprzednia
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={turnsPage >= lastPage} onClick={() => setTurnsPage((p) => p + 1)}>
                  Następna
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirmClearChats} onOpenChange={setConfirmClearChats}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Wyczyścić wszystkie czaty asystenta?</AlertDialogTitle>
            <AlertDialogDescription>
              Usunięte zostaną wszystkie rozmowy wszystkich użytkowników wraz z wiadomościami. Statystyki zużycia pozostaną. Tej operacji nie można cofnąć.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void clearChats()}>
              Usuń czaty
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** Wykres słupkowy dzienny na czystych divach (bez bibliotek). */
function DailyChart({ daily, days }: { daily: AdminAssistantUsage["daily"]; days: number }) {
  const max = Math.max(1, ...daily.map((d) => d.turns));
  const labelEvery = days >= 90 ? 15 : days >= 30 ? 5 : 1;
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">Tury dziennie</h3>
      {daily.length === 0 ? (
        <p className="text-xs text-muted-foreground">Brak danych.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex h-32 min-w-[320px] items-end gap-px" role="img" aria-label={`Wykres tur dziennie za ${days} dni`}>
            {daily.map((d) => (
              <div
                key={d.date}
                className="group flex h-full flex-1 flex-col justify-end"
                title={`${d.date}: ${d.turns} tur, ${fmtInt(d.promptTokens + d.completionTokens)} tokenów`}
              >
                <div
                  className={cn("w-full rounded-t-sm transition-colors", d.turns > 0 ? "bg-primary/70 group-hover:bg-primary" : "bg-muted")}
                  style={{ height: `${Math.max(d.turns > 0 ? 4 : 2, (d.turns / max) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="flex min-w-[320px] gap-px text-[10px] text-muted-foreground">
            {daily.map((d, i) => (
              <div key={d.date} className="flex-1 truncate text-center">
                {i % labelEvery === 0 ? d.date.slice(5) : ""}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
