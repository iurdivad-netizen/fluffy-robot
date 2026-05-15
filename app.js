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

  let pickT, pickO, pickH, pickL, pickC;

  if (header) {
    if (oIdx === -1 || hIdx === -1 || lIdx === -1 || cIdx === -1)
      throw new Error("CSV must have open/high/low/close columns.");
    pickO = (r) => parseFloat(r[oIdx]);
    pickH = (r) => parseFloat(r[hIdx]);
    pickL = (r) => parseFloat(r[lIdx]);
    pickC = (r) => parseFloat(r[cIdx]);
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
      bars.push({ t, o, h, l, c });
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

    sessions.push({
      day,
      sessionOpen, eodClose,
      fixedClose, customClose,
      fixedRange: fixedHi - fixedLo,
      customRange: customHi - customLo,
      dayRange,
      sigFixed, sigCustom, sigEOD,
      retEOD: (eodClose - sessionOpen) / sessionOpen,
    });
  }

  return { sessions, summary: summarize(sessions) };
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

  const meanRangeRatio = (key) => {
    const xs = sessions.filter(s => s.dayRange > 0).map(s => s[key] / s.dayRange);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };

  return {
    total,
    decisive: sessions.filter(decisive).length,
    fixed: matrix("sigFixed"),
    custom: matrix("sigCustom"),
    fixedRangeRatio: meanRangeRatio("fixedRange"),
    customRangeRatio: meanRangeRatio("customRange"),
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
  renderTable(sessions);
  renderChart(sessions);
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

function renderMatrix(id, m, title) {
  const cell = (n, total, agree) => {
    const p = total ? n / total : 0;
    return `<div class="${agree ? "agree" : "disagree"}">${n}<br><span class="muted">${fmtPct(p)}</span></div>`;
  };
  const html = `
    <div class="matrix">
      <div class="corner">${title}</div>
      <div class="h">EOD up</div>
      <div class="h">EOD down</div>
      <div class="h">Window up</div>
      ${cell(m.bb, m.n, true)}
      ${cell(m.bn, m.n, false)}
      <div class="h">Window down</div>
      ${cell(m.nb, m.n, false)}
      ${cell(m.nn, m.n, true)}
    </div>`;
  $(id).innerHTML = html;
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
                "fixedRange", "customRange", "dayRange"];
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
  let day = new Date(Date.UTC(2024, 0, 2, 14, 30)); // 09:30 ET in UTC (winter)
  let rng = mulberry32(42);
  for (let d = 0; d < 120; d++) {
    // Skip weekends.
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
      day = new Date(day.getTime() + 24 * 3600 * 1000);
    }
    const dayBias = (rng() - 0.5) * 0.6;          // overall direction for the day
    const openBias = dayBias + (rng() - 0.5) * 0.4; // opening tilt, correlated with day
    for (let i = 0; i < 26; i++) {
      const t = new Date(day.getTime() + i * 15 * 60 * 1000);
      const driftMin = i < 2 ? openBias * 0.6 : dayBias * 0.15;
      const o = price;
      const ret = (rng() - 0.5) * 0.003 + driftMin * 0.0008;
      const c = o * (1 + ret);
      const hi = Math.max(o, c) * (1 + rng() * 0.0008);
      const lo = Math.min(o, c) * (1 - rng() * 0.0008);
      bars.push({ t: t.getTime(), o, h: hi, l: lo, c });
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
