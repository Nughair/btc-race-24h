# btc-race-24h

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Nughair/btc-race-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Nughair/btc-race-24h/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A washout-recovery trading bot for the cbBTC/USDC 24-hour bars race. It trades
one-minute bars of the Orca cbBTC/USDC pool under the agent-fun/bars-replay/v1
protocol, starting from 1,000 USDC of paper money, long only.

The bot is deliberately patient. A full-size round trip on this pool costs
about 26 bps in fees, slippage and price impact, so strategies that trade
often bleed out. This one buys only after a real washout — the close more
than 1.8% under the trailing 360-bar high, the trailing 120-bar low at least
30 bars old, and the close already bounced more than 0.25% off that low —
then holds through the recovery with a 1.6% hard stop, a 1.75% take-profit
that banks the bounce, a 1.9% trailing stop and a 720-bar time stop. At most
two dip entries per window; if none has happened by bar 1250, one small-risk
insurance trade keeps the day from ending tradeless. On the published dev
window the kit's own grader scores it +$16.78 net with a 0.64% maximum
drawdown (still +$15.97 with every fee doubled).

## Run it

```sh
node main.ts   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=lucky-comet-18&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
