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

async function savantRows(playerId, playerType) {
  return cached(`sv:${playerType}:${playerId}`, 12 * H, async () => {
    const params = new URLSearchParams({
      all: "true", type: "details", player_type: playerType,
      hfSea: `${SEASON}|`,
      game_date_gt: `${SEASON}-03-01`, game_date_lt: `${SEASON}-11-30`,
      min_pitches: "0", min_results: "0",
      sort_col: "pitches", sort_order: "desc",
    });
    params.append(playerType === "pitcher" ? "pitchers_lookup[]" : "batters_lookup[]", String(playerId));
    const r = await fetch(`${SAVANT}?${params}`);
    if (!r.ok) throw new Error(`Savant ${r.status}`);
    await sleep(400); // politeness between heavy pulls
    return parseCsv(await r.text());
  });
}

const person = (id) => cached(`person:${id}`, 240 * H, () =>
  getJson(`${STATS}/people/${id}`).then((j) => j.people?.[0] || {}));

const teamInfo = (id) => cached(`team:${id}`, 240 * H, () =>
  getJson(`${STATS}/teams/${id}`).then((j) => j.teams?.[0] || {}));

const seasonHitting = (id) => cached(`sh:${id}`, 6 * H, async () => {
  const j = await getJson(`${STATS}/people/${id}/stats?stats=season&group=hitting&season=${SEASON}`);
  return j.stats?.[0]?.splits?.[0]?.stat || null;
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

function batterAggregates(rows) {
  const vs = {}, z = {};
  const spray = [];
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
    if (r.type === "X" && r.hc_x && r.hc_y) {
      spray.push({ x: +(+r.hc_x).toFixed(1), y: +(+r.hc_y).toFixed(1), pt: r.pitch_type, ev, d: r.game_date });
    }
  });
  const vsPitch = {};
  Object.entries(vs).forEach(([pt, v]) => { if (v.ab >= 10) vsPitch[pt] = +(v.tb / v.ab).toFixed(3); });
  const zones = [];
  for (let i = 1; i <= 9; i++) zones.push(z[i] && z[i].ab >= 5 ? +(z[i].tb / z[i].ab).toFixed(3) : null);
  spray.sort((a, b) => (a.d < b.d ? 1 : -1));
  return { vsPitch, zones, spray: spray.slice(0, 120).map(({ x, y, pt, ev }) => ({ x, y, pt, ev })) };
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

/* ---------------- scoring (swap in your real model) -------- */
function score(season, slot, parkHR, settersObp) {
  const pa = +season.plateAppearances || 0;
  const hr = +season.homeRuns || 0;
  const g = +season.gamesPlayed || 0;
  const hrRate = pa > 50 ? hr / pa : 0.02;
  const hrPct = +( (1 - Math.pow(1 - hrRate * (parkHR || 1), 4.3)) * 100 ).toFixed(1);
  const xRbi = g > 10 ? +((+season.rbi || 0) / g).toFixed(2) : 0.3;
  const rbiPct = Math.round((1 - Math.exp(-xRbi)) * 100);
  return { hrPct, xRbi, rbiPct, runnersPA: RUNNERS_PA[slot] || 0.4, settersObp };
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
let BOARD = null;          // last assembled payload
let assembling = null;     // in-flight promise

/* signal tags = the aligned data points the terminal hunts for */
function tagsFor(p) {
  const t = [];
  const top = p.sp?.mix?.[0];
  if (top && p.vsPitch && p.vsPitch[top.pt] >= 0.6) t.push("Crushes top pitch");
  if (p.bvp && p.bvp.ab >= 8 && parseFloat(p.bvp.slg) >= 0.6) t.push("Ownage");
  if (p.parkHR >= 1.15) t.push("HR park");
  if (p.settersObp != null && p.settersObp >= 0.35) t.push("Traffic ahead");
  if (p.hrPct >= 20) t.push("Power form");
  return t;
}

async function buildTeamSide(game, sideKey, box) {
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
      const sc = score(f.season, f.slot, parkHR, settersObp);
      const player = {
        id: f.id, name: f.name, slot: f.slot, lineup,
        teamId: team.id, teamAbbr: tInfo.abbreviation || team.name,
        gamePk: game.gamePk, oppTeamId: game.teams[oppKey].team.id,
        bats: p.batSide?.code || "?", sp,
        season: { hr: +f.season.homeRuns, pa: +f.season.plateAppearances, rbi: +f.season.rbi, g: +f.season.gamesPlayed, obp: f.season.obp, slg: f.season.slg },
        ...sc, parkHR,
        bvp: await bvp(f.id, oppSP.id).catch(() => null),
        vsPitch: agg.vsPitch, zones: agg.zones, spray: agg.spray,
        detail: false,
      };
      player.tags = tagsFor(player);
      out.push(player);
    } catch (e) { console.error(`skip ${f.name}: ${e.message}`); }
  }
  // star the two strongest aligned plays per team
  out.slice()
    .sort((a, b) => (b.hrPct + b.tags.length * 3) - (a.hrPct + a.tags.length * 3))
    .slice(0, 2)
    .forEach((p) => { p.suggested = true; });
  return out;
}

async function assembleBoard(date) {
  const sched = await getJson(`${STATS}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,venue`);
  const games = sched.dates?.[0]?.games || [];
  const outGames = [], players = [];
  for (const g of games) {
    if (g.status?.abstractGameState === "Final") continue;
    const box = await boxscore(g.gamePk).catch(() => ({ teams: { away: { players: {} }, home: { players: {} } } }));
    const awayInfo = await teamInfo(g.teams.away.team.id);
    const homeInfo = await teamInfo(g.teams.home.team.id);
    outGames.push({
      gamePk: g.gamePk,
      away: awayInfo.abbreviation || g.teams.away.team.name,
      home: homeInfo.abbreviation || g.teams.home.team.name,
      park: g.venue?.name, parkHR: PARK_HR[g.venue?.name] || 1.0,
      start: g.gameDate, carry: null, // wire a weather API here
      lineupsConfirmed: !!(box.teams?.away?.battingOrder?.length),
    });
    players.push(...(await buildTeamSide(g, "away", box)));
    players.push(...(await buildTeamSide(g, "home", box)));
  }
  return { date, generatedAt: new Date().toISOString(),
    modelNote: "hrPct/xRbi are transparent baseline formulas (see server comments) — replace score() with your model.",
    games: outGames, players };
}

async function warm() {
  const date = new Date().toISOString().slice(0, 10);
  if (assembling) return assembling;
  assembling = assembleBoard(date)
    .then((b) => { BOARD = b; console.log(`[warm] board ready: ${b.players.length} players, ${b.games.length} games`); })
    .catch((e) => console.error("[warm] failed:", e.message))
    .finally(() => { assembling = null; });
  return assembling;
}

/* ---------------- routes ---------------- */
app.get("/api/board", (req, res) => {
  if (BOARD && BOARD.date === new Date().toISOString().slice(0, 10)) {
    res.json(BOARD);
    if (Date.now() - Date.parse(BOARD.generatedAt) > 0.5 * H) warm(); // refresh in background
    return;
  }
  warm(); // kick off in the background — never block the request
  res.json({ warming: true, games: [], players: [] });
});

/* lazy starting-pitcher / any-pitcher arsenal from Statcast */
app.get("/api/arsenal/:pitcherId", async (req, res) => {
  try {
    const rows = await savantRows(req.params.pitcherId, "pitcher");
    res.json(arsenalFromRows(rows));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* lazy Statcast detail (spray, zones, pitch-type SLG) for any batter —
   used when a non-featured lineup player is opened */
app.get("/api/detail/:batterId", async (req, res) => {
  try {
    const rows = await savantRows(req.params.batterId, "batter");
    res.json(rows.length ? batterAggregates(rows) : { vsPitch: null, zones: null, spray: null });
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
      const all = [];
      for (const a of arms) all.push(...(await savantRows(a.person.id, "pitcher").catch(() => [])));
      return arsenalFromRows(all).map(({ pt, pct, velo }) => ({ pt, pct, velo }));
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/health", (_, res) => res.json({ ok: true, boardReady: !!BOARD, generatedAt: BOARD?.generatedAt || null }));

/* ---------------- warm loop (replaces cron) ---------------- */
app.listen(PORT, () => {
  console.log(`Crushed live on :${PORT}`);
  warm();
  setInterval(warm, 30 * 60 * 1000); // lineups firm up through the afternoon
});
