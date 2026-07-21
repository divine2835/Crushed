/* ============================================================
   CRUSHED — LIVE SERVER
   ------------------------------------------------------------
   One process does everything:
   • Serves the site (put barrels-and-ribbies-live.html next to
     this file) — same origin, so no CORS headaches.
   • Assembles the whole slate as one JSON payload (/api/board):
     schedule → lineups → featured batters → Savant arsenals,
     spray, zones, pitch-type SLG → BvP → scores.
   • Warms itself at boot and re-checks every 30 min so lineup
     confirmations flow in all afternoon. Savant pulls cache 12h.

   RUN:
     npm init -y && npm i express
     node server-live.js            →  http://localhost:3001

   DEPLOY (Render/Railway/Fly/any $5 VPS):
     start command: node server-live.js
     The warm loop replaces an external cron.

   DATA SOURCES:
   • MLB Stats API (statsapi.mlb.com) — schedule, probables,
     lineups, season stats, batter-vs-pitcher. Near real time.
   • Baseball Savant statcast_search CSV — pitch-level Statcast.
     Aggregates refresh nightly; params occasionally change, so
     check pybaseball's source if a pull starts 400ing.

   HONESTY NOTES (also surfaced to the frontend):
   • hrPct = 1-(1-HR/PA)^4.3 — a transparent baseline model,
     park-adjusted. Swap in your real model in score().
   • xRbi = season RBI/G; rbiPct = 1-e^(-xRbi) (Poisson).
   • runnersPA uses league-average-by-lineup-slot constants.
   • Carry (weather) is null until you wire a weather API.
   • MLB data terms cover personal/non-commercial use — get
     licensed feeds (e.g. Sportradar) before monetizing.
   ============================================================ */

const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;

const STATS = "https://statsapi.mlb.com/api/v1";
const SAVANT = "https://baseballsavant.mlb.com/statcast_search/csv";
const SEASON = new Date().getFullYear();
const H = 3600_000;

app.use(express.static(__dirname)); // serves the html next to this file

/* ---------------- cache ---------------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- csv ---------------- */
function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const split = (line) => {
    const out = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

/* ---------------- fetch helpers ---------------- */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* Fetch pitch-level rows from Savant and immediately slim them to the
   handful of fields we use. NOT cached — raw rows are huge. Only the
   small computed packs below get cached, which keeps memory tiny on
   free-tier hosts (raw caching was blowing the 512MB limit and
   crashing the server mid-request). */
async function savantRowsRaw(playerId, playerType) {
  const params = new URLSearchParams({
    all: "true", type: "details", player_type: playerType,
    hfSea: `${SEASON}|`,
    game_date_gt: `${SEASON}-03-01`, game_date_lt: `${SEASON}-11-30`,
    min_pitches: "0", min_results: "0",
    sort_col: "pitches", sort_order: "desc",
  });
  params.append(playerType === "pitcher" ? "pitchers_lookup[]" : "batters_lookup[]", String(playerId));
  const res = await fetch(`${SAVANT}?${params}`);
  if (!res.ok) throw new Error(`Savant ${res.status}`);
  await sleep(400); // politeness between heavy pulls
  return parseCsv(await res.text()).map((r) => ({
    pitch_type: r.pitch_type, release_speed: r.release_speed, zone: r.zone,
    hc_x: r.hc_x, hc_y: r.hc_y, events: r.events, type: r.type,
    launch_speed: r.launch_speed, launch_angle: r.launch_angle,
    stand: r.stand, p_throws: r.p_throws, description: r.description,
    game_date: r.game_date,
  }));
}
/* small cached packs (a few KB each) */
const batterPack = (id) => cached(`bpk:${id}`, 12 * H, async () =>
  batterAggregates(await savantRowsRaw(id, "batter")));
const pitcherPack = (id) => cached(`ppk:${id}`, 12 * H, async () => {
  const rows = await savantRowsRaw(id, "pitcher");
  return { mix: arsenalFromRows(rows), swstr: swstrFromRows(rows), n: rows.length };
});

const person = (id) => cached(`person:${id}`, 240 * H, () =>
  getJson(`${STATS}/people/${id}`).then((j) => j.people?.[0] || {}));

const teamInfo = (id) => cached(`team:${id}`, 240 * H, () =>
  getJson(`${STATS}/teams/${id}`).then((j) => j.teams?.[0] || {}));

const seasonHitting = (id) => cached(`sh:${id}`, 6 * H, async () => {
  const j = await getJson(`${STATS}/people/${id}/stats?stats=season&group=hitting&season=${SEASON}`);
  return j.stats?.[0]?.splits?.[0]?.stat || null;
});

/* last-14-days hitting line for the Hot bat signal */
const recentHitting = (id) => cached(`rh:${id}`, 6 * H, async () => {
  const end = new Date(Date.now() - 5 * 3600_000);
  const start = new Date(end.getTime() - 14 * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const j = await getJson(`${STATS}/people/${id}/stats?stats=byDateRange&group=hitting&startDate=${fmt(start)}&endDate=${fmt(end)}&season=${SEASON}`);
  const s = j.stats?.[0]?.splits?.[0]?.stat;
  return s ? { slg: s.slg != null ? +s.slg : null, pa: +s.plateAppearances || 0 } : null;
});

const bvp = (batterId, pitcherId) => cached(`bvp:${batterId}:${pitcherId}`, 24 * H, async () => {
  const j = await getJson(`${STATS}/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`);
  const s = j.stats?.find((x) => x.type?.displayName === "vsPlayerTotal")?.splits?.[0]?.stat;
  return s ? { ab: s.atBats, h: s.hits, hr: s.homeRuns, bb: s.baseOnBalls, so: s.strikeOuts, avg: s.avg, slg: s.slg } : null;
});

/* ---------------- statcast aggregation ---------------- */
const TB = { single: 1, double: 2, triple: 3, home_run: 4 };
const AB_END = new Set(["single","double","triple","home_run","field_out","strikeout","grounded_into_double_play","force_out","double_play","fielders_choice","fielders_choice_out","field_error","triple_play","strikeout_double_play"]);

function arsenalFromRows(rows) {
  const by = {};
  rows.forEach((r) => {
    if (!r.pitch_type) return;
    by[r.pitch_type] = by[r.pitch_type] || { n: 0, velo: 0, zones: {} };
    by[r.pitch_type].n++;
    by[r.pitch_type].velo += parseFloat(r.release_speed) || 0;
    if (r.zone) by[r.pitch_type].zones[r.zone] = (by[r.pitch_type].zones[r.zone] || 0) + 1;
  });
  const total = rows.length || 1;
  return Object.entries(by)
    .map(([pt, v]) => {
      const inZone = Object.entries(v.zones).filter(([z]) => +z <= 9);
      const zTotal = inZone.reduce((s, [, n]) => s + n, 0) || 1;
      const dist = {}; // % of this pitch's in-zone locations, per zone 1–9
      inZone.forEach(([z, n]) => {
        const pctZ = Math.round((n / zTotal) * 100);
        if (pctZ >= 4) dist[z] = pctZ;
      });
      return {
        pt, pct: Math.round((v.n / total) * 100),
        velo: +(v.velo / v.n).toFixed(1),
        zone: +(inZone.sort((a, b) => b[1] - a[1])[0]?.[0]) || null,
        dist,
      };
    })
    .filter((m) => m.pct >= 3)
    .sort((a, b) => b.pct - a.pct);
}

/* Statcast barrel approximation: EV >= 98 with a launch-angle band
   that widens as EV climbs (close to MLB's official definition) */
function isBarrel(ev, la) {
  if (!(ev >= 98) || la == null || isNaN(la)) return false;
  const lower = Math.max(8, 26 - (ev - 98));
  const upper = Math.min(50, 30 + (ev - 98) * 2);
  return la >= lower && la <= upper;
}
const WHIFF = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
function swstrFromRows(rows) {
  if (!rows.length) return null;
  let w = 0;
  rows.forEach((r) => { if (WHIFF.has(r.description)) w++; });
  return +((w / rows.length) * 100).toFixed(1);
}

function batterAggregates(rows) {
  const vs = {}, z = {};
  const spray = [];
  let bbe = 0, hard = 0, pulled = 0;
  const bp = {}; // barrels / batted balls by pitch type
  const hand = { L: { ab: 0, tb: 0 }, R: { ab: 0, tb: 0 } };
  rows.forEach((r) => {
    const ev = r.events;
    if (AB_END.has(ev) && r.pitch_type) {
      vs[r.pitch_type] = vs[r.pitch_type] || { ab: 0, tb: 0 };
      vs[r.pitch_type].ab++;
      vs[r.pitch_type].tb += TB[ev] || 0;
      const zone = +r.zone;
      if (zone >= 1 && zone <= 9) {
        z[zone] = z[zone] || { ab: 0, tb: 0 };
        z[zone].ab++;
        z[zone].tb += TB[ev] || 0;
      }
    }
    if (AB_END.has(ev) && (r.p_throws === "L" || r.p_throws === "R")) {
      hand[r.p_throws].ab++;
      hand[r.p_throws].tb += TB[ev] || 0;
    }
    if (r.type === "X" && r.hc_x && r.hc_y) {
      bbe++;
      const lsp = +r.launch_speed, la = +r.launch_angle;
      if (lsp >= 95) hard++;
      const dx = (+r.hc_x) - 125.42, dz = 198.27 - (+r.hc_y);
      if (dz > 0) {
        const ang = Math.atan2(dx, dz) * 180 / Math.PI; // negative = LF side, positive = RF side
        if ((r.stand === "R" && ang <= -15) || (r.stand === "L" && ang >= 15)) pulled++;
      }
      if (r.pitch_type) {
        bp[r.pitch_type] = bp[r.pitch_type] || { bbe: 0, barrels: 0 };
        bp[r.pitch_type].bbe++;
        if (isBarrel(lsp, la)) bp[r.pitch_type].barrels++;
      }
      spray.push({ x: +(+r.hc_x).toFixed(1), y: +(+r.hc_y).toFixed(1), pt: r.pitch_type, ev, d: r.game_date });
    }
  });
  const vsPitch = {};
  Object.entries(vs).forEach(([pt, v]) => { if (v.ab >= 10) vsPitch[pt] = +(v.tb / v.ab).toFixed(3); });
  const zones = [];
  for (let i = 1; i <= 9; i++) zones.push(z[i] && z[i].ab >= 5 ? +(z[i].tb / z[i].ab).toFixed(3) : null);
  spray.sort((a, b) => (a.d < b.d ? 1 : -1));
  const vsHand = {
    L: hand.L.ab >= THRESH.platoonAb ? +(hand.L.tb / hand.L.ab).toFixed(3) : null,
    R: hand.R.ab >= THRESH.platoonAb ? +(hand.R.tb / hand.R.ab).toFixed(3) : null,
  };
  return {
    vsPitch, zones,
    spray: spray.slice(0, 120).map(({ x, y, pt, ev }) => ({ x, y, pt, ev })),
    hardHitPct: bbe >= 20 ? Math.round((hard / bbe) * 100) : null,
    pullPct: bbe >= 20 ? Math.round((pulled / bbe) * 100) : null,
    barrelsByPt: bp,
    vsHand,
  };
}

/* ---------------- park HR factors (approx, static) ------- */
const PARK_HR = {
  "Coors Field": 1.38, "Great American Ball Park": 1.30, "Yankee Stadium": 1.15,
  "Citizens Bank Park": 1.14, "Globe Life Field": 0.98, "Dodger Stadium": 1.12,
  "Truist Park": 1.04, "Fenway Park": 1.03, "Citi Field": 1.06, "Wrigley Field": 1.02,
  "Angel Stadium": 1.05, "American Family Field": 1.10, "Rogers Centre": 1.05,
  "Minute Maid Park": 1.03, "Daikin Park": 1.03, "Camden Yards": 1.01, "Oriole Park at Camden Yards": 1.01,
  "Guaranteed Rate Field": 1.10, "Rate Field": 1.10, "Chase Field": 1.02, "Nationals Park": 1.00,
  "Target Field": 0.98, "PNC Park": 0.90, "Busch Stadium": 0.88, "Kauffman Stadium": 0.86,
  "Petco Park": 0.95, "loanDepot park": 0.85, "Comerica Park": 0.92, "Progressive Field": 0.98,
  "T-Mobile Park": 0.86, "Oracle Park": 0.82, "George M. Steinbrenner Field": 1.15, "Sutter Health Park": 1.05,
};
const RUNNERS_PA = { 1: 0.31, 2: 0.36, 3: 0.43, 4: 0.47, 5: 0.45, 6: 0.42, 7: 0.40, 8: 0.38, 9: 0.36 };

/* ============================================================
   ★ SIGNAL THRESHOLDS — TUNE ME
   These drive the tags and the gold stars. Adjust freely as
   you learn what actually predicts.
   ============================================================ */
const THRESH = {
  crushSlg: 0.60,     // "Crushes top pitch": SLG vs the SP's most-used pitch
  ownageSlg: 0.60,    // "Ownage": career SLG vs tonight's SP...
  ownageAb: 8,        //   ...with at least this many career ABs
  parkHr: 1.15,       // "HR park": park HR factor at/above this
  settersObp: 0.350,  // "Traffic ahead": combined OBP of the two hitters ahead
  hrPct: 20,          // "Power form": tonight's adjusted HR% at/above this
  hotSlg: 0.550,      // "Hot bat": SLG over the last 14 days...
  hotPa: 25,          //   ...with at least this many PAs in that window
  platoonSlg: 0.550,  // "Platoon edge": season SLG vs the SP's throwing hand...
  platoonAb: 30,      //   ...with at least this many ABs vs that hand
  hardHit: 45,        // "Hard contact": % of batted balls 95+ mph EV
  carry: 1.15,        // "Carry night": weather ball-flight factor
  pullPct: 45,        // "Pull-heavy": pct of batted balls pulled - no number given, tune me
  spSwstr: 10,        // "Hittable arm": SP swinging-strike pct BELOW this
  barrelMix: 13,      // "Barrels the mix": batter barrel pct on the SP's pitch types, at/above...
  barrelMixBbe: 25,   //   ...with at least this many batted balls vs those pitches
  zoneHotSlg: 0.550,  // "Zone overlap": a batter zone counts as hot at this SLG...
  spZonePct: 10,      //   ...an SP zone counts if he locates at least this pct of pitches there...
  zoneOverlap: 3,     //   ...signal fires at this many overlapping zones
  tagWeight: 3,       // star score = HR% + tagWeight × (number of tags)
  starsPerTeam: 2,    // how many players per team get the ★
  prePull: 3,         // top-N per team pre-pulled from Savant for star signals
};

/* ---------------- ballpark geography (approx) --------------
   lat/lon for the weather forecast; cf = compass bearing from
   home plate to center field so wind can be expressed relative
   to the field ("out to CF" etc). Bearings are approximations. */
const STADIA = {
  "Coors Field": { lat: 39.756, lon: -104.994, cf: 25 },
  "Great American Ball Park": { lat: 39.097, lon: -84.507, cf: 118 },
  "Yankee Stadium": { lat: 40.829, lon: -73.926, cf: 75 },
  "Citizens Bank Park": { lat: 39.906, lon: -75.166, cf: 20 },
  "Globe Life Field": { lat: 32.747, lon: -97.084, cf: 65 },
  "Dodger Stadium": { lat: 34.074, lon: -118.240, cf: 25 },
  "Truist Park": { lat: 33.891, lon: -84.468, cf: 145 },
  "Fenway Park": { lat: 42.346, lon: -71.097, cf: 52 },
  "Citi Field": { lat: 40.757, lon: -73.846, cf: 15 },
  "Wrigley Field": { lat: 41.948, lon: -87.655, cf: 40 },
  "Angel Stadium": { lat: 33.800, lon: -117.883, cf: 65 },
  "American Family Field": { lat: 43.028, lon: -87.971, cf: 130 },
  "Rogers Centre": { lat: 43.641, lon: -79.389, cf: 15 },
  "Daikin Park": { lat: 29.757, lon: -95.355, cf: 340 },
  "Minute Maid Park": { lat: 29.757, lon: -95.355, cf: 340 },
  "Camden Yards": { lat: 39.284, lon: -76.622, cf: 30 },
  "Oriole Park at Camden Yards": { lat: 39.284, lon: -76.622, cf: 30 },
  "Rate Field": { lat: 41.830, lon: -87.634, cf: 135 },
  "Guaranteed Rate Field": { lat: 41.830, lon: -87.634, cf: 135 },
  "Chase Field": { lat: 33.445, lon: -112.067, cf: 25 },
  "Nationals Park": { lat: 38.873, lon: -77.007, cf: 87 },
  "Target Field": { lat: 44.982, lon: -93.278, cf: 90 },
  "PNC Park": { lat: 40.447, lon: -80.006, cf: 115 },
  "Busch Stadium": { lat: 38.623, lon: -90.193, cf: 62 },
  "Kauffman Stadium": { lat: 39.051, lon: -94.480, cf: 45 },
  "Petco Park": { lat: 32.707, lon: -117.157, cf: 355 },
  "loanDepot park": { lat: 25.778, lon: -80.220, cf: 75 },
  "Comerica Park": { lat: 42.339, lon: -83.049, cf: 145 },
  "Progressive Field": { lat: 41.496, lon: -81.685, cf: 355 },
  "T-Mobile Park": { lat: 47.591, lon: -122.332, cf: 45 },
  "Oracle Park": { lat: 37.778, lon: -122.389, cf: 85 },
  "George M. Steinbrenner Field": { lat: 27.980, lon: -82.507, cf: 45 },
  "Sutter Health Park": { lat: 38.580, lon: -121.513, cf: 60 },
};
const ROOFED = new Set(["Globe Life Field", "Chase Field", "Rogers Centre", "American Family Field", "Daikin Park", "Minute Maid Park", "loanDepot park"]);

/* game-time forecast from Open-Meteo (free, no API key).
   relDeg: wind direction relative to the field — 0 = blowing
   straight out to CF, 90 = L-to-R, 180 = blowing in, 270 = R-to-L */
async function gameWeather(park, isoStart) {
  const st = STADIA[park];
  if (!st) return null;
  if (ROOFED.has(park)) return { roof: true, tempF: 72, windMph: 0, relDeg: null, label: "Roof", carryWind: 0 };
  const key = `wx:${park}:${String(isoStart).slice(0, 13)}`;
  return cached(key, 1 * H, async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=UTC`;
    const j = await getJson(url);
    const times = j.hourly?.time || [];
    if (!times.length) return null;
    const target = Date.parse(isoStart);
    let bi = 0, bd = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(Date.parse(t + ":00Z") - target);
      if (d < bd) { bd = d; bi = i; }
    });
    const tempF = Math.round(j.hourly.temperature_2m[bi]);
    const windMph = Math.round(j.hourly.wind_speed_10m[bi]);
    const fromDeg = j.hourly.wind_direction_10m[bi];
    const toDeg = (fromDeg + 180) % 360;
    const relDeg = Math.round(((toDeg - st.cf) % 360 + 360) % 360);
    const carryWind = Math.cos(relDeg * Math.PI / 180) * windMph; // + = out, - = in
    const dirWord = relDeg < 22.5 || relDeg >= 337.5 ? "Out to CF"
      : relDeg < 67.5 ? "Out to RF" : relDeg < 112.5 ? "L to R"
      : relDeg < 157.5 ? "In from RF" : relDeg < 202.5 ? "In from CF"
      : relDeg < 247.5 ? "In from LF" : relDeg < 292.5 ? "R to L" : "Out to LF";
    return { roof: false, tempF, windMph, relDeg, label: windMph + " mph " + dirWord, carryWind };
  });
}

/* Carry = weather ball-flight factor: temp + wind out-component
   + altitude. Transparent and clamped; tune freely. */
function carryFactor(park, wx) {
  if (!wx) return null;
  let c = 1 + Math.max(-0.15, Math.min(0.15, ((wx.tempF ?? 72) - 72) * 0.005));
  c += Math.max(-0.2, Math.min(0.2, (wx.carryWind || 0) * 0.013));
  if (park === "Coors Field") c += 0.18;
  return +Math.max(0.6, Math.min(1.7, c)).toFixed(2);
}

/* ---------------- scoring (swap in your real model) -------- */
function score(season, slot, parkHR, settersObp, carry) {
  const pa = +season.plateAppearances || 0;
  const hr = +season.homeRuns || 0;
  const g = +season.gamesPlayed || 0;
  const hrRate = pa > 50 ? hr / pa : 0.02;
  const hrPct = +( (1 - Math.pow(1 - hrRate * (parkHR || 1) * (carry || 1), 4.3)) * 100 ).toFixed(1);
  const xRbi = g > 10 ? +((+season.rbi || 0) / g).toFixed(2) : 0.3;
  const rbiPct = Math.round((1 - Math.exp(-xRbi)) * 100);
  return { hrPct, xRbi, rbiPct, runnersPA: RUNNERS_PA[slot] || 0.4, settersObp };
}

/* ============================================================
   NUMEROLOGY ALIGNMENT — the user's four day-number methods,
   matched against live player data. This is a pattern overlay
   tab, separate from the statistical model scores.
   ============================================================ */
const MASTERS = [11, 22, 33];
function stepsOf(n) {
  n = Math.abs(Math.round(n));
  const st = [n];
  while (n > 9) {
    n = String(n).split("").reduce((s, d) => s + +d, 0);
    st.push(n);
  }
  return st;
}
const markStep = (s) => s + (MASTERS.indexOf(s) !== -1 ? " (Master)" : "");
function pathStr(n) { return stepsOf(n).map(markStep).join(" \u2192 "); }
function tailStr(n) { return stepsOf(n).slice(1).map(markStep).join(" \u2192 "); }
function reduceNum(n) { const st = stepsOf(n); return st[st.length - 1]; }
const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const PLANETS = [
  { name: "Sun", num: 1 }, { name: "Moon", num: 2 }, { name: "Mars", num: 9 },
  { name: "Mercury", num: 5 }, { name: "Jupiter", num: 3 }, { name: "Venus", num: 6 },
  { name: "Saturn", num: 8 },
];
const DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dayNumerology(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const digits = dateStr.replace(/-/g, "").split("").map(Number);
  const lpSum = digits.reduce((s, x) => s + x, 0);
  const lp = reduceNum(lpSum);
  const dom = +dateStr.slice(8, 10);
  const planet = PLANETS[d.getUTCDay()];
  const y = +dateStr.slice(0, 4);
  const doy = Math.floor((Date.UTC(y, +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  const numbers = [
    { num: lp, method: "Date life path", calc: `${digits.join("+")} = ${pathStr(lpSum)}` },
    { num: reduceNum(dom), method: "Day of month", calc: pathStr(dom) },
    { num: planet.num, method: "Planet of the day", calc: `${DAYNAMES[d.getUTCDay()]} = ${planet.name} = ${planet.num}` },
    { num: reduceNum(doy), method: "Day of year", calc: `Day ${doy} of the year` + (doy > 9 ? ` \u2192 ${tailStr(doy)}` : "") },
  ];
  return { date: dateStr, numbers, set: [...new Set(numbers.map((n) => n.num))] };
}

/* season HR/RBI splits vs LHP / RHP (MLB Stats API sitCodes) */
const handSplits = (id) => cached(`hs:${id}`, 6 * H, async () => {
  const j = await getJson(`${STATS}/people/${id}/stats?stats=statSplits&group=hitting&season=${SEASON}&sitCodes=vl,vr`);
  const out = {};
  (j.stats?.[0]?.splits || []).forEach((s) => {
    const code = s.split?.code;
    if (code === "vl" || code === "vr") out[code] = { hr: +(s.stat?.homeRuns || 0), rbi: +(s.stat?.rbi || 0) };
  });
  return out;
});

function numerologyHits(player, personInfo, splits, dayNums) {
  const facts = [];
  const push = (label, value) => { if (value != null && !isNaN(value) && value > 0) facts.push({ label, value }); };
  push(`Next HR of the season would be #${player.season.hr + 1}`, player.season.hr + 1);
  push(`Next RBI would be #${player.season.rbi + 1}`, player.season.rbi + 1);
  push(`Bats ${ORD(player.slot)}`, player.slot);
  const hand = player.sp && player.sp.hand;
  const code = hand === "L" ? "vl" : hand === "R" ? "vr" : null;
  if (code && splits && splits[code]) {
    push(`Next HR vs ${hand}HP would be #${splits[code].hr + 1}`, splits[code].hr + 1);
    push(`Next RBI vs ${hand}HP would be #${splits[code].rbi + 1}`, splits[code].rbi + 1);
  }
  const bd = personInfo.birthDate; // YYYY-MM-DD
  if (bd) {
    const bday = +bd.slice(8, 10);
    push(`Born on the ${ORD(bday)}`, bday);
    const bSum = bd.replace(/-/g, "").split("").reduce((s, x) => s + +x, 0);
    const bSteps = stepsOf(bSum);
    const bMaster = bSteps.find((s) => MASTERS.indexOf(s) !== -1);
    const bFinal = bSteps[bSteps.length - 1];
    push(bMaster ? `Birthday life path ${bMaster} (Master) \u2192 ${bFinal}` : `Birthday life path ${bFinal}`, bFinal);
  }
  if (personInfo.primaryNumber) push(`Wears #${personInfo.primaryNumber}`, +personInfo.primaryNumber);
  const hits = [], seen = new Set();
  facts.forEach((f) => {
    const red = reduceNum(f.value);
    if (dayNums.set.indexOf(red) !== -1) {
      let suffix = "";
      if (f.value > 9) {
        suffix = MASTERS.indexOf(f.value) !== -1
          ? ` (Master) \u2192 ${red}`
          : ` \u2192 ${tailStr(f.value)}`;
      }
      const label = f.label + suffix;
      if (!seen.has(label)) { seen.add(label); hits.push({ label, num: red }); }
    }
  });
  return hits;
}

/* ---------------- lineup helpers ---------------- */
async function boxscore(gamePk) {
  return cached(`box:${gamePk}`, 0.1 * H, () => getJson(`${STATS}/game/${gamePk}/boxscore`));
}

async function recentLineup(teamId) {
  // fallback when tonight's lineup isn't posted: most recent final game
  return cached(`recent:${teamId}`, 3 * H, async () => {
    const end = new Date(), start = new Date(Date.now() - 4 * 86400_000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const j = await getJson(`${STATS}/schedule?sportId=1&teamId=${teamId}&startDate=${fmt(start)}&endDate=${fmt(end)}`);
    const games = (j.dates || []).flatMap((d) => d.games).filter((g) => g.status?.abstractGameState === "Final");
    if (!games.length) return [];
    const last = games[games.length - 1];
    const box = await boxscore(last.gamePk);
    const side = box.teams.away.team.id === teamId ? box.teams.away : box.teams.home;
    return (side.battingOrder || []).map((id, i) => ({
      id, slot: i + 1, name: side.players[`ID${id}`]?.person?.fullName,
    }));
  });
}

/* ---------------- board assembly ---------------- */
let BOARDS = { today: null, tomorrow: null };
let assembling = { today: null, tomorrow: null };
function dayDate(day) {
  // approximate US/Eastern so a late-night UTC clock doesn't skip ahead a slate
  const d = new Date(Date.now() - 5 * 3600_000);
  if (day === "tomorrow") d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* signal tags = the aligned data points the terminal hunts for.
   All thresholds live in THRESH above — tune there. */
function tagsFor(p) {
  const t = [];
  const top = p.sp?.mix?.[0];
  if (top && p.vsPitch && p.vsPitch[top.pt] >= THRESH.crushSlg) t.push("Crushes top pitch");
  if (p.bvp && p.bvp.ab >= THRESH.ownageAb && parseFloat(p.bvp.slg) >= THRESH.ownageSlg) t.push("Ownage");
  if (p.sp && p.vsHand && p.vsHand[p.sp.hand] != null && p.vsHand[p.sp.hand] >= THRESH.platoonSlg && (p.bats === "S" || p.bats === "L" || p.bats === "R")) {
    // a true platoon edge requires the opposite-hand matchup;
    // crushing SAME-hand pitching is its own (rarer) signal
    const opp = p.bats === "S" || (p.bats === "L" && p.sp.hand === "R") || (p.bats === "R" && p.sp.hand === "L");
    t.push(opp ? "Platoon edge" : "Reverse split");
  }
  if (p.hot != null && p.hot >= THRESH.hotSlg) t.push("Hot bat");
  if (p.hardHitPct != null && p.hardHitPct >= THRESH.hardHit) t.push("Hard contact");
  if (p.pullPct != null && p.pullPct >= THRESH.pullPct) t.push("Pull-heavy");
  if (p.sp && p.sp.swstr != null && p.sp.swstr < THRESH.spSwstr) t.push("Hittable arm");
  if (p.barrelsByPt && p.sp && p.sp.mix && p.sp.mix.length) {
    let mb = 0, mbbe = 0;
    p.sp.mix.forEach((m) => {
      const v = p.barrelsByPt[m.pt];
      if (v) { mb += v.barrels; mbbe += v.bbe; }
    });
    if (mbbe >= THRESH.barrelMixBbe && (mb / mbbe) * 100 >= THRESH.barrelMix) t.push("Barrels the mix");
  }
  if (p.zones && p.sp && p.sp.mix && p.sp.mix.length) {
    // SP aggregate location share per zone = sum of usage pct x per-pitch zone dist
    const spZone = {};
    p.sp.mix.forEach((m) => {
      if (!m.dist) return;
      Object.keys(m.dist).forEach((z) => {
        spZone[z] = (spZone[z] || 0) + (m.pct / 100) * m.dist[z];
      });
    });
    let overlap = 0;
    for (let z = 1; z <= 9; z++) {
      if ((spZone[z] || 0) >= THRESH.spZonePct && p.zones[z - 1] != null && p.zones[z - 1] >= THRESH.zoneHotSlg) overlap++;
    }
    if (overlap >= THRESH.zoneOverlap) t.push("Zone overlap");
  }
  if (p.parkHR >= THRESH.parkHr) t.push("HR park");
  if (p.carry != null && p.carry >= THRESH.carry) t.push("Carry night");
  if (p.settersObp != null && p.settersObp >= THRESH.settersObp) t.push("Traffic ahead");
  if (p.hrPct >= THRESH.hrPct) t.push("Power form");
  return t;
}
function starScore(p) { return p.hrPct + p.tags.length * THRESH.tagWeight; }

async function buildTeamSide(game, sideKey, box, carry, dayNums) {
  const team = game.teams[sideKey].team;
  const oppKey = sideKey === "away" ? "home" : "away";
  const oppSP = game.teams[oppKey].probablePitcher;
  const boxSide = box.teams[sideKey];
  let order = (boxSide.battingOrder || []).map((id, i) => ({
    id, slot: i + 1, name: boxSide.players[`ID${id}`]?.person?.fullName,
  }));
  let lineup = "confirmed";
  if (!order.length) { order = await recentLineup(team.id); lineup = "projected"; }
  if (!order.length || !oppSP) return [];

  const spPerson = await person(oppSP.id);
  const tInfo = await teamInfo(team.id);
  const parkHR = PARK_HR[game.venue?.name] || 1.0;
  // NOTE: no Savant pulls during board assembly — the board is built
  // entirely from the MLB Stats API (lineups, probables, season stats,
  // BvP) so it loads fast. Savant detail (arsenal, spray, zones,
  // pitch-type SLG) loads lazily via /api/arsenal and /api/detail
  // when a scout card is opened.
  const sp = { id: oppSP.id, name: oppSP.fullName, hand: spPerson.pitchHand?.code || "?", mix: null };

  // every batter in the order is selectable; season stats for all
  const roster = [];
  for (const o of order) {
    try {
      const s = await seasonHitting(o.id);
      if (s && +s.plateAppearances >= 30) roster.push({ ...o, season: s });
    } catch { /* skip */ }
  }
  const out = [];
  for (const f of roster) {
    try {
      const p = await person(f.id);
      const agg = { vsPitch: null, zones: null, spray: null };
      const ahead = order.filter((o) => o.slot < f.slot).slice(-2);
      let settersObp = null;
      if (ahead.length) {
        const obps = [];
        for (const a of ahead) {
          const s = await seasonHitting(a.id).catch(() => null);
          if (s && s.obp) obps.push(+s.obp);
        }
        if (obps.length) settersObp = +(obps.reduce((x, y) => x + y, 0) / obps.length).toFixed(3);
      }
      const rh = await recentHitting(f.id).catch(() => null);
      const sc = score(f.season, f.slot, parkHR, settersObp, carry);
      const player = {
        id: f.id, name: f.name, slot: f.slot, lineup,
        teamId: team.id, teamAbbr: tInfo.abbreviation || team.name,
        gamePk: game.gamePk, oppTeamId: game.teams[oppKey].team.id,
        bats: p.batSide?.code || "?", sp,
        hot: rh && rh.pa >= THRESH.hotPa ? rh.slg : null,
        hardHitPct: null, pullPct: null, barrelsByPt: null, vsHand: null,
        season: { hr: +f.season.homeRuns, pa: +f.season.plateAppearances, rbi: +f.season.rbi, g: +f.season.gamesPlayed, obp: f.season.obp, slg: f.season.slg },
        ...sc, parkHR, carry: carry != null ? carry : null,
        bvp: await bvp(f.id, oppSP.id).catch(() => null),
        vsPitch: agg.vsPitch, zones: agg.zones, spray: agg.spray,
        detail: false,
      };
      player.tags = tagsFor(player);
      try {
        const splits = await handSplits(f.id).catch(() => ({}));
        player.numerHits = dayNums ? numerologyHits(player, p, splits, dayNums) : [];
      } catch { player.numerHits = []; }
      out.push(player);
    } catch (e) { console.error(`skip ${f.name}: ${e.message}`); }
  }
  // provisional stars from MLB-API signals; refined after Savant enrichment
  out.slice().sort((a, b) => starScore(b) - starScore(a))
    .slice(0, THRESH.starsPerTeam)
    .forEach((p) => { p.suggested = true; });
  return out;
}

async function assembleBoard(date) {
  const sched = await getJson(`${STATS}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,venue`);
  const games = sched.dates?.[0]?.games || [];
  const outGames = [], players = [];
  const dayNums = dayNumerology(date);
  for (const g of games) {
    if (g.status?.abstractGameState === "Final") continue;
    const box = await boxscore(g.gamePk).catch(() => ({ teams: { away: { players: {} }, home: { players: {} } } }));
    const awayInfo = await teamInfo(g.teams.away.team.id);
    const homeInfo = await teamInfo(g.teams.home.team.id);
    const wx = await gameWeather(g.venue?.name, g.gameDate).catch(() => null);
    const carry = carryFactor(g.venue?.name, wx);
    outGames.push({
      gamePk: g.gamePk,
      away: awayInfo.abbreviation || g.teams.away.team.name,
      home: homeInfo.abbreviation || g.teams.home.team.name,
      park: g.venue?.name, parkHR: PARK_HR[g.venue?.name] || 1.0,
      start: g.gameDate,
      carry,
      weather: wx ? { tempF: wx.tempF, windMph: wx.windMph, relDeg: wx.relDeg, label: wx.roof ? "Roof" : wx.label } : null,
      lineupsConfirmed: !!(box.teams?.away?.battingOrder?.length),
    });
    players.push(...(await buildTeamSide(g, "away", box, carry, dayNums)));
    players.push(...(await buildTeamSide(g, "home", box, carry, dayNums)));
  }
  return { date, generatedAt: new Date().toISOString(),
    numerology: dayNums,
    thresholds: THRESH,
    modelNote: "hrPct is park- and weather-adjusted (Carry); xRbi from lineup context — transparent baseline formulas, replace score() with your model.",
    games: outGames, players };
}

/* PRE-PULL: after the light board publishes, pull Savant data for the
   top candidates per team so pitch-mix, platoon, and hard-contact
   signals feed the tags and stars. Runs in the background — the
   board is already being served while this fills in. */
async function enrichDay(day) {
  const b = BOARDS[day];
  if (!b || !b.players.length) return;
  const byTeam = {};
  b.players.forEach((p) => {
    const k = p.gamePk + ":" + p.teamId;
    (byTeam[k] = byTeam[k] || []).push(p);
  });
  for (const k of Object.keys(byTeam)) {
    const group = byTeam[k];
    const top = group.slice().sort((a, b2) => starScore(b2) - starScore(a)).slice(0, THRESH.prePull);
    for (const p of top) {
      try {
        const agg = await batterPack(p.id);
        p.vsPitch = agg.vsPitch; p.zones = agg.zones; p.spray = agg.spray;
        p.hardHitPct = agg.hardHitPct; p.pullPct = agg.pullPct;
        p.barrelsByPt = agg.barrelsByPt; p.vsHand = agg.vsHand;
        p.detail = true;
        if (p.sp && p.sp.id && (!p.sp.mix || p.sp.swstr == null)) {
          const pk = await pitcherPack(p.sp.id).catch(() => null);
          if (pk) {
            if (!p.sp.mix) p.sp.mix = pk.mix;
            p.sp.swstr = pk.swstr;
          }
        }
        p.tags = tagsFor(p);
      } catch (e) { console.error(`[enrich:${day}] skip ${p.name}: ${e.message}`); }
    }
    // re-award the stars now that Savant signals are in
    group.forEach((p) => { p.suggested = false; });
    group.slice().sort((a, b2) => starScore(b2) - starScore(a))
      .slice(0, THRESH.starsPerTeam)
      .forEach((p) => { p.suggested = true; });
  }
  b.generatedAt = new Date().toISOString();
  b.enriched = true;
  console.log(`[enrich:${day}] Statcast signals applied to stars`);
}

function warmDay(day) {
  if (assembling[day]) return assembling[day];
  assembling[day] = assembleBoard(dayDate(day))
    .then((b) => {
      BOARDS[day] = b;
      console.log(`[warm:${day}] board ready: ${b.players.length} players, ${b.games.length} games`);
      return enrichDay(day);
    })
    .catch((e) => console.error(`[warm:${day}] failed:`, e.message))
    .finally(() => { assembling[day] = null; });
  return assembling[day];
}
async function warm() { await warmDay("today"); warmDay("tomorrow"); }

/* ---------------- routes ---------------- */
app.get("/api/board", (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const b = BOARDS[day];
  if (b && b.date === dayDate(day)) {
    res.json(b);
    if (Date.now() - Date.parse(b.generatedAt) > 0.5 * H) warmDay(day); // refresh in background
    return;
  }
  warmDay(day); // kick off in the background — never block the request
  res.json({ warming: true, day, games: [], players: [] });
});

/* lazy starting-pitcher / any-pitcher arsenal from Statcast */
app.get("/api/arsenal/:pitcherId", async (req, res) => {
  try {
    const pk = await pitcherPack(req.params.pitcherId);
    res.json({ mix: pk.mix, swstr: pk.swstr });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* lazy Statcast detail (spray, zones, pitch-type SLG) for any batter —
   used when a non-featured lineup player is opened */
app.get("/api/detail/:batterId", async (req, res) => {
  try {
    res.json(await batterPack(req.params.batterId));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* lazy bullpen aggregate for one team (exclude = probable SP id) */
app.get("/api/pen/:teamId", async (req, res) => {
  try {
    const exclude = String(req.query.exclude || "");
    const data = await cached(`pen:${req.params.teamId}:${exclude}`, 12 * H, async () => {
      const roster = await getJson(`${STATS}/teams/${req.params.teamId}/roster?rosterType=active`);
      const arms = (roster.roster || [])
        .filter((r) => r.position?.abbreviation === "P" && String(r.person.id) !== exclude)
        .slice(0, 5);
      const agg = {}; // pitch counts + velo, weighted across the pen
      for (const a of arms) {
        try {
          const pk = await pitcherPack(a.person.id);
          pk.mix.forEach((mm) => {
            const cnt = pk.n * (mm.pct / 100);
            agg[mm.pt] = agg[mm.pt] || { n: 0, velo: 0 };
            agg[mm.pt].n += cnt;
            agg[mm.pt].velo += mm.velo * cnt;
          });
        } catch { /* skip arm */ }
      }
      const total = Object.values(agg).reduce((s, v) => s + v.n, 0) || 1;
      return Object.entries(agg)
        .map(([pt, v]) => ({ pt, pct: Math.round((v.n / total) * 100), velo: +(v.velo / v.n).toFixed(1) }))
        .filter((mm) => mm.pct >= 3)
        .sort((a, b) => b.pct - a.pct);
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/health", (_, res) => res.json({ ok: true, today: !!BOARDS.today, tomorrow: !!BOARDS.tomorrow, generatedAt: BOARDS.today?.generatedAt || null }));

/* ---------------- warm loop (replaces cron) ---------------- */
app.listen(PORT, () => {
  console.log(`Crushed live on :${PORT}`);
  warm();
  setInterval(warm, 30 * 60 * 1000); // lineups firm up through the afternoon
});
