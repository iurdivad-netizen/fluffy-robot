// Opening Range -> EOD Direction backtester.
// Pure browser, no dependencies. All data stays local.

const $ = (id) => document.getElementById(id);

let RAW_BARS = null;     // [{t: epochMs, o, h, l, c}]
let LAST_RESULT = null;  // {sessions: [...], summary: {...}}

// ---------- CSV parsing ----------

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const split = (line) => {
    // Handles simple quoted fields. OHLC CSVs almost never need full RFC4180.
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const header = split(lines[0]).map(h => h.toLowerCase());
  const looksLikeHeader = header.some(h => /[a-z]/i.test(h) && !/^-?\d/.test(h));
  const startIdx = looksLikeHeader ? 1 : 0;
  const rows = [];
  for (let i = startIdx; i < lines.length; i++) {
    rows.push(split(lines[i]));
  }
  return { header: looksLikeHeader ? header : null, rows };
}

function findCol(header, candidates) {
  if (!header) return -1;
  for (const c of candidates) {
    const i = header.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

function parseTimestamp(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n < 1e12 ? n * 1000 : n; // seconds vs ms
  }
  // Replace " " between date and time with "T" so Date parses cleanly.
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(iso);
  return isNaN(t) ? NaN : t;
}

function parseDateTime(date, time) {
  const d = String(date).trim();
  const t = String(time).trim();
  if (!d) return NaN;
  // Accept YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD
  let dn = d.replace(/\//g, "-");
  if (/^\d{8}$/.test(dn)) dn = `${dn.slice(0,4)}-${dn.slice(4,6)}-${dn.slice(6,8)}`;
  let tn = t || "00:00:00";
  if (/^\d{6}$/.test(tn)) tn = `${tn.slice(0,2)}:${tn.slice(2,4)}:${tn.slice(4,6)}`;
  if (/^\d{4}$/.test(tn)) tn = `${tn.slice(0,2)}:${tn.slice(2,4)}:00`;
  return Date.parse(`${dn}T${tn}`);
}

function csvToBars(text) {
  const { header, rows } = parseCSV(text);
  if (!rows.length) throw new Error("Empty CSV.");

  let tsIdx = findCol(header, ["timestamp", "datetime", "date_time", "time"]);
  let dateIdx = findCol(header, ["date"]);
  let timeIdx = findCol(header, ["time"]);
  // Disambiguate: if both date and time exist, prefer the pair.
  if (dateIdx !== -1 && timeIdx !== -1 && tsIdx === timeIdx) tsIdx = -1;

  const oIdx = findCol(header, ["open", "o"]);
  const hIdx = findCol(header, ["high", "h"]);
  const lIdx = findCol(header, ["low", "l"]);
  const cIdx = findCol(header, ["close", "c"]);
  const vIdx = findCol(header, ["vix", "vix_close", "vixclose"]);

  let pickT, pickO, pickH, pickL, pickC, pickV = () => NaN;

  if (header) {
    if (oIdx === -1 || hIdx === -1 || lIdx === -1 || cIdx === -1)
      throw new Error("CSV must have open/high/low/close columns.");
    pickO = (r) => parseFloat(r[oIdx]);
    pickH = (r) => parseFloat(r[hIdx]);
    pickL = (r) => parseFloat(r[lIdx]);
    pickC = (r) => parseFloat(r[cIdx]);
    if (vIdx !== -1) pickV = (r) => parseFloat(r[vIdx]);
    if (dateIdx !== -1 && timeIdx !== -1 && tsIdx === -1) {
      pickT = (r) => parseDateTime(r[dateIdx], r[timeIdx]);
    } else if (tsIdx !== -1) {
      pickT = (r) => parseTimestamp(r[tsIdx]);
    } else if (dateIdx !== -1) {
      pickT = (r) => parseDateTime(r[dateIdx], "00:00:00");
    } else {
      throw new Error("CSV must have a timestamp or date+time column.");
    }
  } else {
    // Headerless: assume timestamp,o,h,l,c[,vol] OR date,time,o,h,l,c[,vol]
    const ncols = rows[0].length;
    if (ncols >= 5 && !isNaN(parseTimestamp(rows[0][0]))) {
      pickT = (r) => parseTimestamp(r[0]);
      [pickO, pickH, pickL, pickC] = [1,2,3,4].map(i => (r) => parseFloat(r[i]));
    } else if (ncols >= 6) {
      pickT = (r) => parseDateTime(r[0], r[1]);
      [pickO, pickH, pickL, pickC] = [2,3,4,5].map(i => (r) => parseFloat(r[i]));
    } else {
      throw new Error("Could not infer columns in headerless CSV.");
    }
  }

  const bars = [];
  for (const r of rows) {
    const t = pickT(r), o = pickO(r), h = pickH(r), l = pickL(r), c = pickC(r);
    if (!isNaN(t) && !isNaN(o) && !isNaN(h) && !isNaN(l) && !isNaN(c)) {
      const v = pickV(r);
      bars.push(isNaN(v) ? { t, o, h, l, c } : { t, o, h, l, c, v });
    }
  }
  bars.sort((a, b) => a.t - b.t);
  if (!bars.length) throw new Error("No valid bars parsed.");
  return bars;
}

// ---------- Session segmentation ----------

function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Bad time: ${s}`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function localParts(epochMs, tzOffsetMin) {
  // Get YMD + minute-of-day at the given fixed UTC offset.
  const shifted = new Date(epochMs + tzOffsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const minOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const dayKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { dayKey, minOfDay };
}

function backtest(bars, cfg) {
  const sStart = hhmmToMin(cfg.sessStart);
  const sEnd = hhmmToMin(cfg.sessEnd);
  const winFixed = cfg.winFixed;
  const winCustom = cfg.winCustom;
  const tz = cfg.tzOffset;
  const minBars = cfg.minBars;

  // Bucket bars by trading day.
  const byDay = new Map();
  for (const b of bars) {
    const { dayKey, minOfDay } = localParts(b.t, tz);
    if (minOfDay < sStart || minOfDay >= sEnd) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push({ ...b, minOfDay });
  }

  const sessions = [];
  for (const [day, dayBars] of [...byDay.entries()].sort()) {
    if (dayBars.length < minBars) continue;
    dayBars.sort((a, b) => a.t - b.t);

    const sessionOpen = dayBars[0].o;
    const eodClose = dayBars[dayBars.length - 1].c;

    // VIX for the period: last bar carrying a vix value, else the configured constant.
    let sessionVix = cfg.vixConst;
    for (let i = dayBars.length - 1; i >= 0; i--) {
      if (dayBars[i].v != null && isFinite(dayBars[i].v)) { sessionVix = dayBars[i].v; break; }
    }

    // Highest/lowest within fixed and custom windows.
    const within = (b, mins) => b.minOfDay - dayBars[0].minOfDay < mins;
    const fixedBars = dayBars.filter(b => within(b, winFixed));
    const customBars = dayBars.filter(b => within(b, winCustom));
    if (!fixedBars.length || !customBars.length) continue;

    const fixedClose = fixedBars[fixedBars.length - 1].c;
    const customClose = customBars[customBars.length - 1].c;
    const fixedHi = Math.max(...fixedBars.map(b => b.h));
    const fixedLo = Math.min(...fixedBars.map(b => b.l));
    const customHi = Math.max(...customBars.map(b => b.h));
    const customLo = Math.min(...customBars.map(b => b.l));

    const dayHi = Math.max(...dayBars.map(b => b.h));
    const dayLo = Math.min(...dayBars.map(b => b.l));
    const dayRange = dayHi - dayLo;

    const sigFixed = fixedClose === sessionOpen ? 0 : (fixedClose > sessionOpen ? 1 : -1);
    const sigCustom = customClose === sessionOpen ? 0 : (customClose > sessionOpen ? 1 : -1);
    const sigEOD = eodClose === sessionOpen ? 0 : (eodClose > sessionOpen ? 1 : -1);

    // Index of the first bar that prints the day high / low.
    let hiIdx = 0, loIdx = 0;
    for (let i = 0; i < dayBars.length; i++) if (dayBars[i].h === dayHi) { hiIdx = i; break; }
    for (let i = 0; i < dayBars.length; i++) if (dayBars[i].l === dayLo) { loIdx = i; break; }
    const denom = Math.max(1, dayBars.length - 1);
    const tHighFrac = hiIdx / denom;
    const tLowFrac = loIdx / denom;

    const dayHighInFixed = hiIdx < fixedBars.length;
    const dayLowInFixed  = loIdx < fixedBars.length;
    const dayHighInCustom = hiIdx < customBars.length;
    const dayLowInCustom  = loIdx < customBars.length;

    sessions.push({
      day,
      sessionOpen, eodClose, sessionVix,
      fixedClose, customClose,
      fixedHi, fixedLo, customHi, customLo,
      fixedRange: fixedHi - fixedLo,
      customRange: customHi - customLo,
      dayRange,
      sigFixed, sigCustom, sigEOD,
      retEOD: (eodClose - sessionOpen) / sessionOpen,
      tHighFrac, tLowFrac,
      dayHighInFixed, dayLowInFixed, dayHighInCustom, dayLowInCustom,
      orbFixed: firstBreak(dayBars, fixedBars.length, fixedHi, fixedLo),
      orbCustom: firstBreak(dayBars, customBars.length, customHi, customLo),
      multFixed: (fixedHi - fixedLo) > 0 ? dayRange / (fixedHi - fixedLo) : null,
      multCustom: (customHi - customLo) > 0 ? dayRange / (customHi - customLo) : null,
      extUpFixed:   (fixedHi - fixedLo) > 0 ? (dayHi - fixedHi) / (fixedHi - fixedLo) : null,
      extDownFixed: (fixedHi - fixedLo) > 0 ? (fixedLo - dayLo) / (fixedHi - fixedLo) : null,
      extUpCustom:   (customHi - customLo) > 0 ? (dayHi - customHi) / (customHi - customLo) : null,
      extDownCustom: (customHi - customLo) > 0 ? (customLo - dayLo) / (customHi - customLo) : null,
    });
  }

  return {
    sessions,
    summary: summarize(sessions),
    vixBand: vixBandStats(sessions, cfg.annBasis),
  };
}

// Reproduces the "Expected SPX Movement by timeframe" indicator as a counter.
// For each period the expected move is VIX / sqrt(annBasis) (in %). The band is
// drawn around the PREVIOUS period's close (matching the indicator's [1] offset),
// and the current period is a "breakout" if it closes outside that band.
// This is the options view: a short-premium trade wins when price stays inside.
function vixBandStats(sessions, annBasis) {
  const scale = Math.sqrt(annBasis);
  let inside = 0, outside = 0;
  const rows = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1], cur = sessions[i];
    const vix = prev.sessionVix;
    if (vix == null || !isFinite(vix) || vix < 0 || !(prev.eodClose > 0)) continue;
    const movePct = vix / scale;
    const upper = prev.eodClose * (1 + movePct / 100);
    const lower = prev.eodClose * (1 - movePct / 100);
    const isIn = cur.eodClose <= upper && cur.eodClose >= lower;
    if (isIn) inside++; else outside++;
    cur.emVix = vix;
    cur.emMovePct = movePct;
    cur.emLower = lower;
    cur.emUpper = upper;
    cur.emInside = isIn;
    rows.push({ day: cur.day, vix, movePct, lower, upper, close: cur.eodClose, inside: isIn });
  }
  const evaluated = inside + outside;
  return {
    annBasis, scale, evaluated, inside, outside,
    pInside: evaluated ? inside / evaluated : 0,
    pOutside: evaluated ? outside / evaluated : 0,
    rows,
  };
}

// Scan bars after the opening window to see which side of the OR is touched first.
// Returns 1 (high broken first), -1 (low broken first), 0 (neither).
function firstBreak(dayBars, fromIdx, orHi, orLo) {
  for (let i = fromIdx; i < dayBars.length; i++) {
    const b = dayBars[i];
    const up = b.h > orHi, dn = b.l < orLo;
    if (up && dn) {
      // Intra-bar ambiguity: pick the side closer to the bar open.
      return Math.abs(b.o - orHi) < Math.abs(b.o - orLo) ? 1 : -1;
    }
    if (up) return 1;
    if (dn) return -1;
  }
  return 0;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

function histogram(values, bins) {
  const h = new Array(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
    h[i]++;
  }
  return h;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const MULT_THRESHOLDS = [1.0, 1.25, 1.5, 2.0, 3.0, 5.0];
const MULT_BINS = [
  [0, 1, "<1x"],
  [1, 1.25, "1–1.25x"],
  [1.25, 1.5, "1.25–1.5x"],
  [1.5, 2, "1.5–2x"],
  [2, 3, "2–3x"],
  [3, 5, "3–5x"],
  [5, Infinity, "≥5x"],
];

const EXT_THRESHOLDS = [0, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0];
const EXT_BINS = [
  [0, 0.25, "0–0.25x"],
  [0.25, 0.5, "0.25–0.5x"],
  [0.5, 1, "0.5–1x"],
  [1, 2, "1–2x"],
  [2, 3, "2–3x"],
  [3, 5, "3–5x"],
  [5, Infinity, "≥5x"],
];

function extStats(values) {
  const xs = values.filter(v => v != null && isFinite(v)).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return {
    n, mean,
    median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    max: xs[n - 1],
    thresholds: EXT_THRESHOLDS.map(t => ({
      t, count: xs.filter(v => v >= t).length,
      p: xs.filter(v => v >= t).length / n,
    })),
    hist: EXT_BINS.map(([lo, hi, label]) => ({
      label, count: xs.filter(v => v >= lo && v < hi).length,
    })),
  };
}

// Bucket sessions into quartiles by an OR-size key, then report mean OR /
// mean day range / mean & median multiple per bucket. Lets us see whether
// wide openings systematically lead to wide days, or narrow openings
// expand more in OR units.
function quartileBuckets(sessions, sizeKey, multKey) {
  const valid = sessions.filter(s => s[sizeKey] > 0).slice().sort((a, b) => a[sizeKey] - b[sizeKey]);
  const n = valid.length;
  if (n < 4) return { n, buckets: [] };
  const buckets = [];
  for (let q = 0; q < 4; q++) {
    const lo = Math.floor(q * n / 4);
    const hi = Math.floor((q + 1) * n / 4);
    const slice = valid.slice(lo, hi);
    if (!slice.length) continue;
    const ors = slice.map(s => s[sizeKey]);
    const dayRs = slice.map(s => s.dayRange);
    const mults = slice.map(s => s[multKey]).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    buckets.push({
      label: `Q${q + 1}`,
      n: slice.length,
      orMin: ors[0], orMax: ors[ors.length - 1],
      orMean: ors.reduce((a, b) => a + b, 0) / ors.length,
      dayMean: dayRs.reduce((a, b) => a + b, 0) / dayRs.length,
      multMean: mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 0,
      multMedian: mults.length ? quantile(mults, 0.5) : 0,
    });
  }
  return { n, buckets };
}

function multStats(values) {
  const xs = values.filter(v => v != null && isFinite(v)).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const stats = {
    n,
    mean,
    median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    max: xs[n - 1],
    min: xs[0],
    thresholds: MULT_THRESHOLDS.map(t => ({
      t, count: xs.filter(v => v >= t).length,
      p: xs.filter(v => v >= t).length / n,
    })),
    hist: MULT_BINS.map(([lo, hi, label]) => ({
      label,
      count: xs.filter(v => v >= lo && v < hi).length,
    })),
  };
  return stats;
}

function summarize(sessions) {
  const total = sessions.length;
  const decisive = (s) => s.sigEOD !== 0;

  function matrix(sigKey) {
    // Counts of (window, eod) in {-1, 1}; ignore zeros.
    const m = { bb: 0, bn: 0, nb: 0, nn: 0 }; // bull-bull, bull-bear, bear-bull, bear-bear
    for (const s of sessions) {
      if (s[sigKey] === 0 || s.sigEOD === 0) continue;
      const w = s[sigKey] > 0, e = s.sigEOD > 0;
      if (w && e) m.bb++;
      else if (w && !e) m.bn++;
      else if (!w && e) m.nb++;
      else m.nn++;
    }
    const n = m.bb + m.bn + m.nb + m.nn;
    const bullSig = m.bb + m.bn;
    const bearSig = m.nb + m.nn;
    return {
      ...m, n,
      pBullHit: bullSig ? m.bb / bullSig : 0,
      pBearHit: bearSig ? m.nn / bearSig : 0,
      pAgree: n ? (m.bb + m.nn) / n : 0,
      pBullSig: n ? bullSig / n : 0,
    };
  }

  const pFlag = (key) => total ? sessions.filter(s => s[key]).length / total : 0;
  const fixedRanges = sessions.map(s => s.fixedRange);
  const customRanges = sessions.map(s => s.customRange);
  const dayRanges = sessions.map(s => s.dayRange);

  const meanRangeRatio = (key) => {
    const xs = sessions.filter(s => s.dayRange > 0).map(s => s[key] / s.dayRange);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };

  return {
    total,
    decisive: sessions.filter(decisive).length,
    fixed: matrix("sigFixed"),
    custom: matrix("sigCustom"),
    orbFixed: matrix("orbFixed"),
    orbCustom: matrix("orbCustom"),
    fixedRangeRatio: meanRangeRatio("fixedRange"),
    customRangeRatio: meanRangeRatio("customRange"),
    pHighInFixed: pFlag("dayHighInFixed"),
    pLowInFixed:  pFlag("dayLowInFixed"),
    pHighInCustom: pFlag("dayHighInCustom"),
    pLowInCustom:  pFlag("dayLowInCustom"),
    pEitherInFixed: total ? sessions.filter(s => s.dayHighInFixed || s.dayLowInFixed).length / total : 0,
    pEitherInCustom: total ? sessions.filter(s => s.dayHighInCustom || s.dayLowInCustom).length / total : 0,
    histHigh: histogram(sessions.map(s => s.tHighFrac), 10),
    histLow:  histogram(sessions.map(s => s.tLowFrac), 10),
    corrFixedDay: pearson(fixedRanges, dayRanges),
    corrCustomDay: pearson(customRanges, dayRanges),
    multFixed: multStats(sessions.map(s => s.multFixed)),
    multCustom: multStats(sessions.map(s => s.multCustom)),
    extUpFixed:   extStats(sessions.map(s => s.extUpFixed)),
    extDownFixed: extStats(sessions.map(s => s.extDownFixed)),
    extUpCustom:   extStats(sessions.map(s => s.extUpCustom)),
    extDownCustom: extStats(sessions.map(s => s.extDownCustom)),
    quartFixed:  quartileBuckets(sessions, "fixedRange",  "multFixed"),
    quartCustom: quartileBuckets(sessions, "customRange", "multCustom"),
    firstDay: sessions[0]?.day,
    lastDay: sessions[sessions.length - 1]?.day,
  };
}

// ---------- Rendering ----------

const fmtPct = (x) => (x * 100).toFixed(1) + "%";
const fmtNum = (x, d = 2) => (x ?? 0).toFixed(d);

function renderResults(result) {
  $("results").classList.remove("hidden");
  const { summary, sessions } = result;
  renderKPIs(summary);
  renderMatrix("matrix-fixed", summary.fixed, "Fixed window");
  renderMatrix("matrix-custom", summary.custom, "Custom window");
  renderHLKPIs(summary);
  renderHistogram(summary.histHigh, summary.histLow);
  renderMatrix("matrix-orb-fixed", summary.orbFixed, "Fixed ORB", { rowUp: "Break up first", rowDn: "Break down first" });
  renderMatrix("matrix-orb-custom", summary.orbCustom, "Custom ORB", { rowUp: "Break up first", rowDn: "Break down first" });
  renderMultiples(summary);
  renderExtensions(summary);
  renderQuartile("quart-fixed",  summary.quartFixed);
  renderQuartile("quart-custom", summary.quartCustom);
  renderVixBand(result.vixBand);
  renderTable(sessions);
  renderChart(sessions);
}

function renderVixBand(vb) {
  const html = [
    kpi("Periods evaluated", vb.evaluated, `annualization &radic;${vb.annBasis}`),
    kpi("Stayed inside band", vb.inside, fmtPct(vb.pInside) + " of periods"),
    kpi("Breakouts", vb.outside, fmtPct(vb.pOutside) + " of periods"),
    kpi("Short-premium win rate", fmtPct(vb.pInside), "price contained → trade wins"),
  ].join("");
  $("vix-kpis").innerHTML = html;

  const wins = vb.inside, n = vb.evaluated;
  const expWin = n ? wins / n : 0;
  $("vix-thresh").innerHTML = `
    <thead><tr><th>outcome</th><th>count</th><th>share</th><th></th></tr></thead>
    <tbody>
      <tr>
        <td>Inside band (win)</td>
        <td>${wins} / ${n}</td>
        <td>${fmtPct(expWin)}</td>
        <td><span class="bar" style="width:${Math.round(expWin * 120)}px"></span></td>
      </tr>
      <tr>
        <td>Breakout (loss)</td>
        <td>${vb.outside} / ${n}</td>
        <td>${fmtPct(vb.pOutside)}</td>
        <td><span class="bar" style="width:${Math.round(vb.pOutside * 120)}px"></span></td>
      </tr>
    </tbody>`;

  if (!vb.rows.length) {
    $("vix-table").innerHTML = `<tbody><tr><td class="muted">No periods evaluated. Need at least 2 sessions and a VIX value.</td></tr></tbody>`;
    return;
  }
  const headers = ["period", "VIX", "exp move %", "band low", "band high", "close", "result"];
  const rows = vb.rows.slice(-60).reverse().map(r => `
    <tr>
      <td>${r.day}</td>
      <td>${fmtNum(r.vix, 2)}</td>
      <td>${fmtNum(r.movePct, 2)}%</td>
      <td>${fmtNum(r.lower)}</td>
      <td>${fmtNum(r.upper)}</td>
      <td>${fmtNum(r.close)}</td>
      <td class="${r.inside ? "up" : "down"}">${r.inside ? "inside" : "breakout"}</td>
    </tr>`).join("");
  $("vix-table").innerHTML =
    `<thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
}

function renderHLKPIs(s) {
  const html = [
    kpi("Day high in fixed window", fmtPct(s.pHighInFixed), "P(day high set in first N min)"),
    kpi("Day low in fixed window", fmtPct(s.pLowInFixed), "P(day low set in first N min)"),
    kpi("Either extreme in fixed", fmtPct(s.pEitherInFixed), "P(high OR low in window)"),
    kpi("Day high in custom window", fmtPct(s.pHighInCustom), ""),
    kpi("Day low in custom window", fmtPct(s.pLowInCustom), ""),
    kpi("Either extreme in custom", fmtPct(s.pEitherInCustom), ""),
    kpi("corr(fixed range, day range)", s.corrFixedDay.toFixed(3), "Pearson"),
    kpi("corr(custom range, day range)", s.corrCustomDay.toFixed(3), "Pearson"),
  ].join("");
  $("hl-kpis").innerHTML = html;
}

function renderKPIs(s) {
  const html = [
    kpi("Sessions", s.total, `${s.firstDay || ""} &rarr; ${s.lastDay || ""}`),
    kpi("Decisive EOD", s.decisive, `${fmtPct(s.total ? s.decisive / s.total : 0)} of sessions`),
    kpi("Fixed agreement", fmtPct(s.fixed.pAgree), `n=${s.fixed.n}`),
    kpi("Custom agreement", fmtPct(s.custom.pAgree), `n=${s.custom.n}`),
    kpi("Fixed bull hit", fmtPct(s.fixed.pBullHit), "P(EOD up | window up)"),
    kpi("Fixed bear hit", fmtPct(s.fixed.pBearHit), "P(EOD down | window down)"),
    kpi("Fixed range / day", fmtPct(s.fixedRangeRatio), "mean opening range %"),
    kpi("Custom range / day", fmtPct(s.customRangeRatio), "mean opening range %"),
  ].join("");
  $("kpis").innerHTML = html;
}

function kpi(label, value, sub) {
  return `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${value}</div>
    <div class="sub">${sub || ""}</div></div>`;
}

function renderMatrix(id, m, title, labels = {}) {
  const rowUp = labels.rowUp || "Window up";
  const rowDn = labels.rowDn || "Window down";
  const cell = (n, total, agree) => {
    const p = total ? n / total : 0;
    return `<div class="${agree ? "agree" : "disagree"}">${n}<br><span class="muted">${fmtPct(p)}</span></div>`;
  };
  const agree = m.n ? (m.bb + m.nn) / m.n : 0;
  const html = `
    <div class="matrix">
      <div class="corner">${title}<br><span class="muted">agree ${fmtPct(agree)} (n=${m.n})</span></div>
      <div class="h">EOD up</div>
      <div class="h">EOD down</div>
      <div class="h">${rowUp}</div>
      ${cell(m.bb, m.n, true)}
      ${cell(m.bn, m.n, false)}
      <div class="h">${rowDn}</div>
      ${cell(m.nb, m.n, false)}
      ${cell(m.nn, m.n, true)}
    </div>`;
  $(id).innerHTML = html;
}

function renderMultiples(s) {
  const f = s.multFixed, c = s.multCustom;
  const fmtX = (v) => v.toFixed(2) + "x";
  const html = [
    kpi("Fixed median multiple", fmtX(f.median), `mean ${fmtX(f.mean)} (n=${f.n})`),
    kpi("Fixed P25 / P75", `${fmtX(f.p25)} / ${fmtX(f.p75)}`, `max ${fmtX(f.max)}`),
    kpi("Custom median multiple", fmtX(c.median), `mean ${fmtX(c.mean)} (n=${c.n})`),
    kpi("Custom P25 / P75", `${fmtX(c.p25)} / ${fmtX(c.p75)}`, `max ${fmtX(c.max)}`),
  ].join("");
  $("mult-kpis").innerHTML = html;

  renderThresholdTable("mult-thresh-fixed", f);
  renderThresholdTable("mult-thresh-custom", c);
  renderMultHistogram(f.hist, c.hist);
}

function renderThresholdTable(id, stats) {
  const rows = stats.thresholds.map(({ t, count, p }) => `
    <tr>
      <td>day range ≥ ${t.toFixed(2)}x OR</td>
      <td>${count} / ${stats.n}</td>
      <td>${fmtPct(p)}</td>
      <td><span class="bar" style="width:${Math.round(p * 120)}px"></span></td>
    </tr>`).join("");
  $(id).innerHTML = `
    <thead><tr><th>threshold</th><th>count</th><th>share</th><th></th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderMultHistogram(fixedHist, customHist) {
  const canvas = $("mult-hist");
  const w = canvas.clientWidth || 800;
  const h = parseInt(canvas.getAttribute("height"), 10);
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 12, padT = 14, padB = 36;
  const bins = fixedHist.length;
  const maxV = Math.max(1, ...fixedHist.map(b => b.count), ...customHist.map(b => b.count));
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const groupW = innerW / bins;
  const barW = groupW / 2 - 3;

  ctx.strokeStyle = "#2a2f3a";
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB); ctx.stroke();

  ctx.fillStyle = "#9aa3b2";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(maxV, padL - 6, padT + 9);
  ctx.fillText("0", padL - 6, h - padB);

  ctx.textAlign = "center";
  for (let i = 0; i < bins; i++) {
    const x0 = padL + i * groupW + 2;
    const hF = (fixedHist[i].count / maxV) * innerH;
    const hC = (customHist[i].count / maxV) * innerH;
    ctx.fillStyle = "#4f8cff";
    ctx.fillRect(x0, h - padB - hF, barW, hF);
    ctx.fillStyle = "#2dd4bf";
    ctx.fillRect(x0 + barW + 3, h - padB - hC, barW, hC);
    ctx.fillStyle = "#9aa3b2";
    ctx.fillText(fixedHist[i].label, x0 + groupW / 2 - 2, h - padB + 14);
  }

  ctx.fillStyle = "#4f8cff";
  ctx.fillRect(padL + 4, padT - 4, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.textAlign = "left";
  ctx.fillText("fixed", padL + 18, padT + 5);
  ctx.fillStyle = "#2dd4bf";
  ctx.fillRect(padL + 58, padT - 4, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.fillText("custom", padL + 72, padT + 5);
}

function renderQuartile(id, q) {
  if (!q.buckets.length) {
    $(id).innerHTML = `<tbody><tr><td class="muted">Need at least 4 sessions.</td></tr></tbody>`;
    return;
  }
  const rows = q.buckets.map(b => `
    <tr>
      <td>${b.label} <span class="muted">(${b.n})</span></td>
      <td>${fmtNum(b.orMin, 2)} – ${fmtNum(b.orMax, 2)}</td>
      <td>${fmtNum(b.orMean, 2)}</td>
      <td>${fmtNum(b.dayMean, 2)}</td>
      <td>${b.multMean.toFixed(2)}x</td>
      <td>${b.multMedian.toFixed(2)}x</td>
    </tr>`).join("");
  $(id).innerHTML = `
    <thead><tr>
      <th>bucket</th><th>OR size range</th><th>avg OR</th>
      <th>avg day range</th><th>avg multiple</th><th>median multiple</th>
    </tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderExtensions(s) {
  const fmtX = (v) => v.toFixed(2) + "x";
  const html = [
    kpi("Fixed upside ext (median)",   fmtX(s.extUpFixed.median),   `mean ${fmtX(s.extUpFixed.mean)}  P75 ${fmtX(s.extUpFixed.p75)}`),
    kpi("Fixed downside ext (median)", fmtX(s.extDownFixed.median), `mean ${fmtX(s.extDownFixed.mean)}  P75 ${fmtX(s.extDownFixed.p75)}`),
    kpi("Custom upside ext (median)",   fmtX(s.extUpCustom.median),   `mean ${fmtX(s.extUpCustom.mean)}  P75 ${fmtX(s.extUpCustom.p75)}`),
    kpi("Custom downside ext (median)", fmtX(s.extDownCustom.median), `mean ${fmtX(s.extDownCustom.mean)}  P75 ${fmtX(s.extDownCustom.p75)}`),
  ].join("");
  $("ext-kpis").innerHTML = html;

  renderExtThreshold("ext-thresh-fixed",  s.extUpFixed,   s.extDownFixed);
  renderExtThreshold("ext-thresh-custom", s.extUpCustom,  s.extDownCustom);
  renderExtHistogram(s.extUpFixed.hist, s.extDownFixed.hist);
}

function renderExtThreshold(id, up, dn) {
  const rows = up.thresholds.map((u, i) => {
    const d = dn.thresholds[i];
    return `<tr>
      <td>&ge; ${u.t.toFixed(2)}x OR</td>
      <td class="up">${u.count}</td>
      <td class="up">${fmtPct(u.p)}</td>
      <td class="down">${d.count}</td>
      <td class="down">${fmtPct(d.p)}</td>
    </tr>`;
  }).join("");
  $(id).innerHTML = `
    <thead><tr><th>threshold</th><th>upside #</th><th>upside %</th><th>downside #</th><th>downside %</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderExtHistogram(upBins, dnBins) {
  const canvas = $("ext-hist");
  const w = canvas.clientWidth || 800;
  const h = parseInt(canvas.getAttribute("height"), 10);
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 12, padT = 14, padB = 36;
  const bins = upBins.length;
  const maxV = Math.max(1, ...upBins.map(b => b.count), ...dnBins.map(b => b.count));
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const groupW = innerW / bins;
  const barW = groupW / 2 - 3;

  ctx.strokeStyle = "#2a2f3a";
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB); ctx.stroke();

  ctx.fillStyle = "#9aa3b2";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(maxV, padL - 6, padT + 9);
  ctx.fillText("0", padL - 6, h - padB);

  ctx.textAlign = "center";
  for (let i = 0; i < bins; i++) {
    const x0 = padL + i * groupW + 2;
    const hU = (upBins[i].count / maxV) * innerH;
    const hD = (dnBins[i].count / maxV) * innerH;
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x0, h - padB - hU, barW, hU);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x0 + barW + 3, h - padB - hD, barW, hD);
    ctx.fillStyle = "#9aa3b2";
    ctx.fillText(upBins[i].label, x0 + groupW / 2 - 2, h - padB + 14);
  }

  ctx.fillStyle = "#22c55e";
  ctx.fillRect(padL + 4, padT - 4, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.textAlign = "left";
  ctx.fillText("upside (OR high → day high)", padL + 18, padT + 5);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(padL + 188, padT - 4, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.fillText("downside (OR low → day low)", padL + 202, padT + 5);
}

function renderHistogram(highBins, lowBins) {
  const canvas = $("hist");
  const w = canvas.clientWidth || 800;
  const h = parseInt(canvas.getAttribute("height"), 10);
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 12, padT = 12, padB = 28;
  const bins = highBins.length;
  const maxV = Math.max(1, ...highBins, ...lowBins);
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const groupW = innerW / bins;
  const barW = groupW / 2 - 2;

  ctx.strokeStyle = "#2a2f3a";
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB); ctx.stroke();

  ctx.fillStyle = "#9aa3b2";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(maxV, padL - 6, padT + 9);
  ctx.fillText("0", padL - 6, h - padB);
  ctx.textAlign = "left";
  ctx.fillText("open", padL, h - 8);
  ctx.textAlign = "right";
  ctx.fillText("close", w - padR, h - 8);

  for (let i = 0; i < bins; i++) {
    const x0 = padL + i * groupW + 2;
    const hHi = (highBins[i] / maxV) * innerH;
    const hLo = (lowBins[i] / maxV) * innerH;
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x0, h - padB - hHi, barW, hHi);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x0 + barW + 2, h - padB - hLo, barW, hLo);
  }

  // Legend
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(padL + 4, padT + 2, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.textAlign = "left";
  ctx.fillText("day high", padL + 18, padT + 11);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(padL + 78, padT + 2, 10, 10);
  ctx.fillStyle = "#9aa3b2";
  ctx.fillText("day low", padL + 92, padT + 11);
}

function renderTable(sessions) {
  const headers = ["day", "open", "fixed close", "custom close", "EOD close", "fixed sig", "custom sig", "EOD sig", "EOD return"];
  const rows = sessions.slice(0, 200).map(s => `
    <tr>
      <td>${s.day}</td>
      <td>${fmtNum(s.sessionOpen)}</td>
      <td>${fmtNum(s.fixedClose)}</td>
      <td>${fmtNum(s.customClose)}</td>
      <td>${fmtNum(s.eodClose)}</td>
      <td class="${s.sigFixed > 0 ? "up" : s.sigFixed < 0 ? "down" : ""}">${sigLabel(s.sigFixed)}</td>
      <td class="${s.sigCustom > 0 ? "up" : s.sigCustom < 0 ? "down" : ""}">${sigLabel(s.sigCustom)}</td>
      <td class="${s.sigEOD > 0 ? "up" : s.sigEOD < 0 ? "down" : ""}">${sigLabel(s.sigEOD)}</td>
      <td class="${s.retEOD > 0 ? "up" : s.retEOD < 0 ? "down" : ""}">${(s.retEOD * 100).toFixed(2)}%</td>
    </tr>`).join("");
  $("sessions-table").innerHTML =
    `<thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
}

function sigLabel(s) {
  if (s > 0) return "up";
  if (s < 0) return "down";
  return "flat";
}

// ---------- Chart (no dependencies) ----------

function renderChart(sessions) {
  const canvas = $("chart");
  const w = canvas.clientWidth || 800;
  const h = parseInt(canvas.getAttribute("height"), 10);
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  // Cumulative count of agreements vs disagreements for fixed window.
  const pts = [];
  let agree = 0, disagree = 0;
  for (const s of sessions) {
    if (s.sigFixed === 0 || s.sigEOD === 0) continue;
    if ((s.sigFixed > 0) === (s.sigEOD > 0)) agree++;
    else disagree++;
    pts.push({ day: s.day, net: agree - disagree, agree, disagree });
  }
  if (!pts.length) return;

  const padL = 50, padR = 12, padT = 12, padB = 28;
  const xN = pts.length;
  const ys = pts.map(p => p.net);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  const xAt = (i) => padL + (i / Math.max(1, xN - 1)) * (w - padL - padR);
  const yAt = (v) => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (h - padT - padB);

  // Axes
  ctx.strokeStyle = "#2a2f3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB); ctx.stroke();

  // Zero line
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = "#3a4150";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, yAt(0)); ctx.lineTo(w - padR, yAt(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Y labels
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  [yMin, (yMin + yMax) / 2, yMax].forEach(v => {
    ctx.fillText(v.toFixed(0), padL - 6, yAt(v) + 3);
  });

  // X endpoints
  ctx.textAlign = "left";
  ctx.fillText(pts[0].day, padL, h - 8);
  ctx.textAlign = "right";
  ctx.fillText(pts[pts.length - 1].day, w - padR, h - 8);

  // Line
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = xAt(i), y = yAt(p.net);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ---------- Glue ----------

function readConfig() {
  return {
    sessStart: $("sess-start").value,
    sessEnd: $("sess-end").value,
    winFixed: parseInt($("win-fixed").value, 10),
    winCustom: parseInt($("win-custom").value, 10),
    tzOffset: parseInt($("tz-offset").value, 10),
    minBars: parseInt($("min-bars").value, 10),
    vixConst: parseFloat($("vix-const").value),
    annBasis: parseInt($("ann-basis").value, 10),
  };
}

function setStatus(msg) { $("data-status").textContent = msg; }

function setBars(bars, label) {
  RAW_BARS = bars;
  $("run").disabled = false;
  const first = new Date(bars[0].t).toISOString().slice(0, 16).replace("T", " ");
  const last = new Date(bars[bars.length - 1].t).toISOString().slice(0, 16).replace("T", " ");
  setStatus(`${label}: ${bars.length.toLocaleString()} bars, ${first} → ${last} UTC`);
}

$("csv-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  setStatus("Reading…");
  try {
    const text = await f.text();
    const bars = csvToBars(text);
    setBars(bars, f.name);
  } catch (err) {
    setStatus("Error: " + err.message);
  }
});

$("load-sample").addEventListener("click", () => {
  const bars = generateSample();
  setBars(bars, "synthetic sample");
});

$("run").addEventListener("click", () => {
  if (!RAW_BARS) return;
  try {
    const result = backtest(RAW_BARS, readConfig());
    if (!result.sessions.length) {
      setStatus("No sessions matched the configured window. Check session times and timezone.");
      return;
    }
    LAST_RESULT = result;
    renderResults(result);
    setStatus(`Backtested ${result.sessions.length} sessions.`);
  } catch (err) {
    setStatus("Error: " + err.message);
  }
});

$("download-csv").addEventListener("click", () => {
  if (!LAST_RESULT) return;
  const cols = ["day", "sessionOpen", "fixedClose", "customClose", "eodClose",
                "sigFixed", "sigCustom", "sigEOD", "retEOD",
                "fixedHi", "fixedLo", "customHi", "customLo",
                "fixedRange", "customRange", "dayRange",
                "tHighFrac", "tLowFrac",
                "dayHighInFixed", "dayLowInFixed",
                "dayHighInCustom", "dayLowInCustom",
                "orbFixed", "orbCustom",
                "multFixed", "multCustom",
                "extUpFixed", "extDownFixed", "extUpCustom", "extDownCustom",
                "sessionVix", "emVix", "emMovePct", "emLower", "emUpper", "emInside"];
  const lines = [cols.join(",")];
  for (const s of LAST_RESULT.sessions) {
    lines.push(cols.map(k => s[k]).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "sessions.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Synthetic sample data ----------

function generateSample() {
  // 120 trading days of 15-min bars, US Eastern session (09:30-16:00 = 26 bars).
  // Random walk with mild opening-range -> EOD bias to make the indicator look "interesting".
  const bars = [];
  let price = 4500;
  let vix = 18;
  let day = new Date(Date.UTC(2024, 0, 2, 14, 30)); // 09:30 ET in UTC (winter)
  let rng = mulberry32(42);
  for (let d = 0; d < 120; d++) {
    // Skip weekends.
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
      day = new Date(day.getTime() + 24 * 3600 * 1000);
    }
    const dayBias = (rng() - 0.5) * 0.6;          // overall direction for the day
    const openBias = dayBias + (rng() - 0.5) * 0.4; // opening tilt, correlated with day
    // Slow mean-reverting VIX-like series, bounded to a realistic range.
    vix = Math.max(10, Math.min(45, vix + (rng() - 0.5) * 3 + (18 - vix) * 0.05));
    for (let i = 0; i < 26; i++) {
      const t = new Date(day.getTime() + i * 15 * 60 * 1000);
      const driftMin = i < 2 ? openBias * 0.6 : dayBias * 0.15;
      const o = price;
      const ret = (rng() - 0.5) * 0.003 + driftMin * 0.0008;
      const c = o * (1 + ret);
      const hi = Math.max(o, c) * (1 + rng() * 0.0008);
      const lo = Math.min(o, c) * (1 - rng() * 0.0008);
      bars.push({ t: t.getTime(), o, h: hi, l: lo, c, v: vix });
      price = c;
    }
    day = new Date(day.getTime() + 24 * 3600 * 1000);
  }
  return bars;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
