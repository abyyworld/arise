// The Money screen's numbers (lib/money.ts), kept ready: the bank statement lines in the life log
// over the last 13 months, read on this device in idle time a little after the app opens and after
// the log changes, and kept in memory only. Nothing of it is saved or sent anywhere. The coach gets
// only a short monthly summary, and only an AI that may read money (tier 3, like the bank lines
// themselves: life/tiers.ts).

import * as AI from '../ai.js';
import * as S from '../store';
import * as MN from '../lib/money';
import * as L from './log';
import { hasLifeStore } from './store-port';

const DAY = 86_400_000;
const BACK = 400 * DAY; // about 13 months

interface Kept {
  at: number;
  txs: MN.Tx[];
}

let cache: Kept | null = null;
let running: Promise<Kept | null> | null = null;
let gen = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

const logHere = () => hasLifeStore() && L.hasLifeDB();

// The bank lines, oldest first.
export async function readTxs(now = Date.now()): Promise<MN.Tx[]> {
  if (!logHere()) return [];
  const events = await L.eventsBetween(now - BACK, now + DAY, { sources: ['bank'], kinds: ['purchase'], limit: 100000 });
  return events
    .map(MN.txOf)
    .filter((t): t is MN.Tx => !!t)
    .sort((a, b) => a.at - b.at);
}

function work(): Promise<Kept | null> {
  if (running) return running;
  const g = gen;
  const p: Promise<Kept | null> = (async () => {
    let txs: MN.Tx[] = [];
    try {
      txs = await readTxs();
    } catch {
      txs = [];
    }
    if (g !== gen) return null;
    cache = { at: Date.now(), txs };
    return cache;
  })().finally(() => {
    if (running === p) running = null;
  });
  running = p;
  return p;
}

// The lines as read last, or null.
export const peekTxs = () => cache?.txs ?? null;

// The lines, read again when older than `maxAge` (ms).
export async function getTxs({ maxAge = Infinity }: { maxAge?: number } = {}): Promise<MN.Tx[]> {
  if (cache && Date.now() - cache.at <= maxAge) return cache.txs;
  return (await work())?.txs ?? [];
}

// The summary with the Player's own categories as they are now.
export function summary(now = Date.now()): MN.Summary | null {
  if (!cache?.txs.length) return null;
  return MN.summarize(cache.txs, now, S.moneyCats());
}

export function forgetMoney() {
  gen++;
  cache = null;
  running = null;
  clearTimeout(timer);
}

const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 10000 });
  else fn();
};
function later(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(
    () =>
      idle(() => {
        if (running) later(1000);
        else work().catch(() => {});
      }),
    ms,
  );
}

// For the coach: the short monthly summary, only for an AI that may read money.
export function contextFor(cap: number, compact = false) {
  if (cap < 3) return { text: '', tier: 1 as const };
  if (started && !cache) later(0);
  return MN.moneyText(summary(), cap, compact);
}

export function initMoney({ delay = 5000 }: { delay?: number } = {}) {
  if (started) return;
  started = true;
  AI.useMore('money', (cap: number, compact: boolean) => contextFor(cap, compact));
  L.onChange(() => later(6000));
  L.onClearing(forgetMoney);
  S.onReset(forgetMoney);
  if (delay >= 0) later(delay);
}
