import type { UIMessageChunk } from "ai";

/**
 * Serwerowy runner tur asystenta (wzór: roleplay/src/lib/roleplay/turnRunner.ts).
 * Generacja tury żyje NIEZALEŻNIE od żądania HTTP: chunki UI Message Streamu trafiają do
 * bufora w RAM, a każdy widz (także po F5 albo z drugiej karty) dostaje replay bufora od zera
 * + live ogon (GET /assistant/chats/:id/stream). Rozłączenie klienta niczego nie przerywa —
 * abort tylko przez stopTurn (POST /stop, DELETE czatu) albo twardy timeout.
 *
 * Jedna aktywna tura na czat (reserveTurn → null = 409 busy). Ten sam slot rezerwują też
 * operacje lokalne bez modelu (/choose, /quick-change) — zwalniają go releaseTurn.
 *
 * Cykl życia w POST /message:
 *   reserveTurn() → zapis wiadomości usera → streamText({ abortSignal: turn.abort.signal })
 *   → runTurn(stream) → odpowiedź z subscribeTurn().
 */

/** Twardy limit czasu jednej tury (8 kroków × wolny dostawca to realnie ~60–120 s). */
export const TURN_TIMEOUT_MS = 180_000;

export type StoppedBy = "user" | "timeout" | null;

export interface RunningTurn {
  abort: AbortController;
  timeout: NodeJS.Timeout;
  startedAt: number;
  /** Kto przerwał: Stop z frontu / usunięcie czatu / twardy timeout; null = nikt (tura żyje albo skończyła się sama). */
  stoppedBy: StoppedBy;
  /** runTurn wystartował — sprzątanie należy do jego finally. */
  started: boolean;
  done: boolean;
  chunks: UIMessageChunk[];
  subscribers: Set<ReadableStreamDefaultController<UIMessageChunk>>;
}

const turns = new Map<number, RunningTurn>();

export function getTurn(chatId: number): RunningTurn | undefined {
  return turns.get(chatId);
}

/**
 * Rezerwuje slot tury (synchronicznie na event loopie) ZANIM handler utrwali wiadomość usera:
 * przegrany wyścigu dwóch POST-ów dostaje null (→ 409 busy) bez żadnego zapisu. Timeout
 * przerywa generację i jest też samonaprawą slotu, gdyby handler rzucił przed startem streamu.
 */
export function reserveTurn(chatId: number): RunningTurn | null {
  if (turns.has(chatId)) return null;
  const turn: RunningTurn = {
    abort: new AbortController(),
    startedAt: Date.now(),
    stoppedBy: null,
    started: false,
    done: false,
    chunks: [],
    subscribers: new Set(),
    timeout: setTimeout(() => {
      turn.stoppedBy = "timeout";
      turn.abort.abort(new Error("timeout"));
      // Slot zwalnia finally runnera; gdyby generacja nigdy nie ruszyła — sprzątamy sami.
      if (!turn.started) setTimeout(() => releaseTurn(chatId, turn), 5_000).unref?.();
    }, TURN_TIMEOUT_MS),
  };
  turns.set(chatId, turn);
  return turn;
}

/** Zwolnienie slotu (operacje bez streamu; finally runnera). Zamyka widzów i zwalnia bufor. */
export function releaseTurn(chatId: number, turn: RunningTurn): void {
  turn.done = true;
  clearTimeout(turn.timeout);
  for (const sub of turn.subscribers) {
    try {
      sub.close();
    } catch {
      /* widz już odpięty */
    }
  }
  turn.subscribers.clear();
  // Po zakończeniu źródłem prawdy jest baza — bufor od razu zwalniamy.
  if (turns.get(chatId) === turn) turns.delete(chatId);
}

/**
 * Konsumuje stream tury w tle — niezależnie od widzów, więc onEnd streamu (persist odpowiedzi)
 * wykona się ZAWSZE, nawet gdy nikt nie ogląda. Po końcu zwalnia slot.
 */
export function runTurn(chatId: number, turn: RunningTurn, stream: ReadableStream<UIMessageChunk>): void {
  turn.started = true;
  void (async () => {
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        broadcast(turn, value);
      }
    } catch (e) {
      console.error(`[assistant] tura czatu ${chatId} przerwana błędem strumienia:`, e);
      broadcast(turn, { type: "error", errorText: "Generacja przerwana błędem serwera." } as UIMessageChunk);
    } finally {
      releaseTurn(chatId, turn);
    }
  })();
}

function broadcast(turn: RunningTurn, chunk: UIMessageChunk): void {
  turn.chunks.push(chunk);
  for (const sub of [...turn.subscribers]) {
    try {
      sub.enqueue(chunk);
    } catch {
      turn.subscribers.delete(sub);
    }
  }
}

/**
 * Podpina widza: synchroniczny replay bufora od zera + live ogon. Odpięcie klienta (cancel)
 * usuwa tylko subskrypcję — generacji nie przerywa. null, gdy nic nie leci (→ 204 dla resume).
 */
export function subscribeTurn(chatId: number): ReadableStream<UIMessageChunk> | null {
  const turn = turns.get(chatId);
  if (!turn || turn.done || !turn.started) return null;
  let ctrl: ReadableStreamDefaultController<UIMessageChunk>;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      ctrl = controller;
      for (const chunk of turn.chunks) controller.enqueue(chunk);
      turn.subscribers.add(controller);
    },
    cancel() {
      turn.subscribers.delete(ctrl);
    },
  });
}

/** Jawne zatrzymanie tury (Stop w UI / DELETE czatu) — dalej działa ścieżka onAbort/onEnd. */
export function stopTurn(chatId: number, reason = "stopped by user"): boolean {
  const turn = turns.get(chatId);
  if (!turn) return false;
  turn.stoppedBy = "user";
  turn.abort.abort(new Error(reason));
  return true;
}
