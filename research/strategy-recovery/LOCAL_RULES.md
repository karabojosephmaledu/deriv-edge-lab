# Local checks without AI-provider credits

The automatic worker uses closed Deriv OHLC data and local code. It does not import or call the AI adapter, model-discovery endpoints, Gemini or OpenRouter. Existing keys can stay in the backend environment without being used by this path. This removes AI-credit requirements, not broker commissions, hosting limits, market risk or the need for an authorized account.

All 16 original PDFs and the complete Pulse Entry seed remain preserved in the original library. **This is not an exact offline replacement for every discretionary interpretation of all 17 sources.** Fifteen entries remain explicitly `unverifiable` in the local evaluator. Their undefined zone-strength, swing, news, session, indicator or entry/exit rules are not guessed and do not add agreement votes.

## Executable source-linked subset

The local evaluator combines CRT's documented range-raid/confirmation pattern and exits with Giant Killer's documented three-opposite-candle reversal variant. Both are evaluated separately and must agree under the existing evidence policy. Giant Killer remains on its stated **M15/H1** timeframes; an M1 version is not invented. The scheduler checks each closed M1 bar across the user's selected markets, but these source entries occur only when their own source timeframe has just closed. Scanning every minute cannot guarantee a trade every minute.

Exact conditions:

1. Read the previous closed Deriv daily bar as the previous trading-day range. This uses the provider's daily boundary, not an invented local-session clock.
2. A closed M15/H1 CRT range candle must test the actual prior-day extreme and close on its valid side: its low reaches or crosses the prior-day low and closes above it for a buy, or its high reaches or crosses the prior-day high and closes below it for a sell. The original exact-price-equality restriction was an implementation error, not a document requirement. No arbitrary zone width/touch tolerance is introduced.
3. The following candle must raid beyond the range candle's extreme, close back inside the CRT range, and also reclaim the prior-day level on its valid side.
4. The next three candles must reverse with the documented opposite body colour. Their successive highs/lows must also show unambiguous HH/HL or LH/LL structure, and the final body must close beyond the raid candle's opposite extreme. The existing global clear-structure requirement is still applied.
5. The current closed M1 timestamp must coincide with that final source-candle close. Old signals are not chased later.
6. CRT provides the stop beyond the raid extreme and target at the opposite **CRT range candle** extreme. Actual closed OHLC anchors are returned; the existing broker adapter places its one-price-increment outside stop and verifies actual quote barriers. The admissible quote interval lies between the raid-break level and the final confirmation candle's already-observed extreme. This is a conservative executable bound, not a claim that the PDFs specify a universal fill tolerance.

Bullish and bearish cases mirror one another. References: CRT pages 1–4; Giant Killer pages 17–19 and its M15/H1 restriction on page 3. The books' platform/leverage recommendations and claims of winning consistency are not evidence that the Options contract has the same payoff or will profit. Contract availability, leverage, commission, exit validation and actual settlement still come from Deriv. No artificial payout, Martingale or forced entry was added.

The four counted events are the daily key level, separate source-frame CRT range candle, subsequent raid, and later body-close confirmation. Two matching document interpretations can authorize a quote only after the unchanged policy's minimum evidence/structure rules pass. The heuristic score is not a probability. Missing conditions return WAIT/NO_STRATEGY_MATCH; malformed data returns INVALID_SETUP.

## Selected-market rotation

The public catalog verifies `active_symbols` and **both** `MULTUP` and `MULTDOWN` from `contracts_for`. The watchlist is frozen for a session. Closed/unsupported markets are skipped, candidates are checked in rotating order, and there is only one actual contract at a time. Account authorization and an authenticated quote remain mandatory before every buy. A different symbol cannot reuse another market's tick, candles, setup, result or order identifier. Higher-timeframe histories are cached until their next close; stale M1 data still blocks entry. Legitimate forex/metal session gaps are retained without filling weekend candles.

Read-only provider checks returned Multiplier contracts for XAUUSD, BTCUSD, EURUSD, GBPUSD, USDJPY and the existing volatility markets. NAS100 (`OTC_NDX`), US30 (`OTC_DJI`), UK100 (`OTC_FTSE`) and HK50 (`OTC_HSI`) returned no Multiplier contracts and are shown disabled. These are current public capabilities, not proof of availability for every authorized account. The bot does not silently switch to MT5/CFDs or enable Live execution.

## Validation and limits

Tests cover mirrored valid patterns, rejected incomplete patterns, wrong source timeframes, source/evidence attribution, no network calls in local analysis, no-key startup, selected-market isolation, unsupported/closed markets, session gaps, frozen watchlists, price-display rotation, actual settlements and existing account/session protections. A real Python → Node worker smoke check completed with all six AI-slot keys absent and evaluated all 17 source records. Public discovery verified 19 market records in about 2.6 seconds; 15 had Multiplier contracts and four requested stock indices did not.

No authenticated broker orders or profitable backtest claims are part of these checks. Further discretionary strategies need complete mechanical definitions and separate validation before being marked executable. The source documents remain available for that work.

The per-market status now explains whether the source candle is still open, the prior-day level was not tested, the raid/close-back is missing, or the reversal structure is incomplete. Between source closes it reports the next M15/H1 boundary in the browser's local time. These diagnostics do not authorize an entry. See [the waiting audit](WAIT_AUDIT.md) for the public-data trigger counts and their limits.
