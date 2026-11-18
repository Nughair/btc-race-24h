// Washout-recovery bot for the cbBTC/USDC 24h bars race (agent-fun/bars-replay/v1).
//
// Idea, from studying the dev window's tape: at 1-minute granularity this pool's
// price mean-reverts after shocks and bleeds slowly the rest of the time, while a
// full-size round trip costs ~26 bps in fees, slippage and impact. Trend chasing
// and EMA crosses pay that toll dozens of times and bleed out; buy-and-hold eats
// whatever drawdown the day brings. What the tape actually pays for is patience:
// buy only after a real washout (a fast, deep drawdown from the trailing high)
// once the price has stopped making new lows and bounced off the bottom, then
// hold through the recovery with exits wide enough not to be shaken out.
//
// Rules (all state is a pure function of the bars seen; no clock, no randomness):
//   Entry (dip): at least 360 bars of history; the close is more than 1.8% below
//     the highest close of the last 360 bars; the lowest close of the last 120
//     bars is at least 30 bars old (the fall has stopped) and the close has
//     bounced more than 0.25% off that low. After an entry that was stopped out,
//     the next dip must be deeper (2.2%) to count. At most 2 dip entries, a
//     60-bar cooldown after every exit, and no entries after bar 1380.
//   Exit (dip): hard stop 1.6% under the fill price, take-profit 1.75% over the
//     fill price (bank the bounce before it fades), trailing stop 1.9% under
//     the best close since entry, or 720 bars held, whichever comes first.
//   Insurance: if no dip entry has happened by bar 1250 and the last hour is up
//     more than 0.2%, take one small-risk trade (stop 1.0%, trailing 1.0%, 120
//     bars) so the day is never left without a single trade.
//   Sizing: all-in on the buy (the position cap is 100% of equity), full exit on
//     a sell. Orders cap slippage at 1000 bps past the decision close; an exit
//     the market refuses is simply sent again on the next bar while its reason
//     still holds.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL_PICK = 0; // the universe holds one symbol; take hello's first

const DIP_HISTORY = 360; // bars of history before the first dip entry
const DIP_LOOKBACK = 360; // trailing-high window
const DIP_LOW_LOOKBACK = 120; // trailing-low window
const DIP_DRAWDOWN = 0.018; // close this far under the trailing high
const DIP_DRAWDOWN_AFTER_STOP = 0.022; // deeper, after a stopped-out entry
const DIP_BOUNCE = 0.0025; // close this far above the trailing low
const DIP_LOW_AGE = 30; // the low must be at least this many bars old
const DIP_MAX_ENTRIES = 2;
const DIP_STOP = 0.016; // hard stop under the fill price
const DIP_TAKE_PROFIT = 0.0175; // bank the bounce at this gain over the fill price
const DIP_TRAIL = 0.019; // trailing stop under the best close since entry
const DIP_MAX_HOLD = 720; // bars
const COOLDOWN = 60; // bars after an exit before any new entry
const LAST_ENTRY_BAR = 1380; // no new entries this close to the end

const INS_BAR = 1250; // insurance entry only after this bar
const INS_LOOKBACK = 60;
const INS_MIN_RISE = 0.002; // the last hour must be up at least this much
const INS_STOP = 0.01;
const INS_TRAIL = 0.01;
const INS_MAX_HOLD = 120;

const MAX_SLIPPAGE_BPS = 1000;

/** Closes of the traded symbol, in order; index = bar number within the run. */
const closes: number[] = [];

let dipsUsed = 0;
let stoppedOut = false;
let coolUntilBar = -1;
let holding: { kind: 'dip' | 'ins'; entryPrice: number; entryBar: number; bestClose: number } | null = null;

function windowMax(from: number, to: number): number {
  let m = -Infinity;
  for (let j = from; j <= to; j++) if (closes[j]! > m) m = closes[j]!;
  return m;
}

function windowMinIndex(from: number, to: number): number {
  let idx = from;
  for (let j = from; j <= to; j++) if (closes[j]! < closes[idx]!) idx = j;
  return idx;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[SYMBOL_PICK]!.symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);

    // Fold this batch's fills into the position record before deciding.
    for (const fill of batch.fills) {
      if (fill.symbol !== symbol || fill.status !== 'filled') continue;
      if (fill.side === 'buy' && holding === null) {
        // The fill happened at this batch's bar open; that bar's close is
        // pushed right after this loop, so it takes index closes.length.
        holding = {
          kind: fill.client_id.startsWith('ins') ? 'ins' : 'dip',
          entryPrice: Number(fill.price),
          entryBar: closes.length,
          bestClose: Number(fill.price),
        };
        dipsUsed++;
      } else if (fill.side === 'sell') {
        holding = null;
      }
    }

    if (bar === undefined) return []; // no bar for our symbol this minute
    closes.push(Number(bar.c));
    const i = closes.length - 1;
    const close = closes[i]!;
    if (state.warmingUp) return [];

    const held = state.positions.get(symbol);

    // ----- in a position: exits only -------------------------------------
    if (held !== undefined && holding !== null) {
      if (close > holding.bestClose) holding.bestClose = close;
      const stop = holding.kind === 'dip' ? DIP_STOP : INS_STOP;
      const trail = holding.kind === 'dip' ? DIP_TRAIL : INS_TRAIL;
      const maxHold = holding.kind === 'dip' ? DIP_MAX_HOLD : INS_MAX_HOLD;
      const takeProfit =
        holding.kind === 'dip' && close >= holding.entryPrice * (1 + DIP_TAKE_PROFIT);
      const exit =
        close <= holding.entryPrice * (1 - stop) ||
        takeProfit ||
        close <= holding.bestClose * (1 - trail) ||
        i - holding.entryBar >= maxHold;
      if (exit) {
        if (close <= holding.entryPrice * (1 - stop)) stoppedOut = true;
        coolUntilBar = i + COOLDOWN;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // ----- flat: entries only --------------------------------------------
    if (held !== undefined) {
      // A position the fills never told us about (should not happen: every
      // fill is reported). Adopt it on dip terms from the current close
      // rather than sit out the rest of the window while holding it.
      holding = { kind: 'dip', entryPrice: close, entryBar: i, bestClose: close };
      return [];
    }
    if (i < coolUntilBar || i > LAST_ENTRY_BAR) return [];

    if (dipsUsed < DIP_MAX_ENTRIES && i >= DIP_HISTORY) {
      const high = windowMax(i - DIP_LOOKBACK, i);
      const lowIdx = windowMinIndex(i - DIP_LOW_LOOKBACK, i);
      const low = closes[lowIdx]!;
      const need = stoppedOut ? DIP_DRAWDOWN_AFTER_STOP : DIP_DRAWDOWN;
      if (close / high - 1 < -need && close / low - 1 > DIP_BOUNCE && i - lowIdx >= DIP_LOW_AGE) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `dip${dipsUsed + 1}` }];
        }
        return [];
      }
    }

    if (dipsUsed === 0 && i >= INS_BAR && i >= INS_LOOKBACK) {
      if (close / closes[i - INS_LOOKBACK]! - 1 > INS_MIN_RISE) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: 'ins1' }];
        }
      }
    }
    return [];
  },
});
