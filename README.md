# Opening Range / EOD Direction Backtester

A static, browser-only tool that backtests the concept from
[these notes](https://github.com/iurdivad-netizen/super-duper-octo-memory/blob/claude/sp500-daily-direction-indicator-QtemO/sp500_opening_range_eod_direction_indicator_notes.md):

> Does the direction of the first 15-minute (and an optional custom N-minute)
> opening window agree with the end-of-day direction?

The page accepts any intraday OHLC CSV — any symbol, any timeframe, spanning
days, weeks, or years — and reports per-session signals, an agreement matrix,
conditional hit rates, and a cumulative agreement chart. Everything runs
locally; no data is uploaded.

## Use it

1. Open the published GitHub Pages URL.
2. Click **Load synthetic sample** (or upload your own CSV).
3. Adjust session times / window sizes / timezone offset.
4. Click **Run backtest**.

## CSV format

Columns are auto-detected. Either of these works:

```
timestamp,open,high,low,close
2024-01-02T09:30:00,4742.10,4744.30,4740.50,4743.20
...
```

```
date,time,open,high,low,close,volume
2024-01-02,09:30,4742.10,4744.30,4740.50,4743.20,12345
...
```

Timestamps may be ISO 8601, `YYYY-MM-DD HH:MM:SS`, or a Unix epoch
(seconds or ms). Set the **Timezone offset** field to match how your
timestamps are encoded so the session window lines up correctly
(e.g. `-300` for US Eastern standard time, `0` for UTC).

## Enable GitHub Pages

In the repo on github.com:

1. **Settings → Pages**
2. **Source: Deploy from a branch**
3. **Branch:** the branch containing these files, **folder:** `/ (root)`
4. Save. The site appears at `https://<user>.github.io/<repo>/`.

## Files

- `index.html` — UI
- `styles.css` — styling
- `app.js` — CSV parsing, session segmentation, backtest, rendering
