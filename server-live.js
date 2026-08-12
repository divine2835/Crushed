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
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;

const STATS = "https://statsapi.mlb.com/api/v1";
const SAVANT = "https://baseballsavant.mlb.com/statcast_search/csv";
const SEASON = new Date().getFullYear();
const H = 3600_000;

app.use(express.static(__dirname)); // serves the html next to this file
app.use(express.json({ limit: "100kb" }));

/* ---------------- PWA shell: manifest, service worker, icons — all served
   from this one file so the two-file deploy ritual never grows ---------------- */
const ICON_192 = "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";
const ICON_512 = "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";
const ICON_180 = "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";
app.get("/icon-192.png", (q, r) => { r.type("png").send(Buffer.from(ICON_192, "base64")); });
app.get("/icon-512.png", (q, r) => { r.type("png").send(Buffer.from(ICON_512, "base64")); });
app.get("/apple-touch-icon.png", (q, r) => { r.type("png").send(Buffer.from(ICON_180, "base64")); });
app.get("/manifest.json", (q, r) => {
  r.json({ name: "Crushed", short_name: "Crushed", start_url: "/", display: "standalone",
    background_color: "#0d1117", theme_color: "#0d1117",
    icons: [ { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
             { src: "/icon-512.png", sizes: "512x512", type: "image/png" } ] });
});
app.get("/sw.js", (q, r) => {
  r.type("application/javascript").send(`
const SHELL = "crushed-shell-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(clients.claim()); });
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put("/", copy));
      return res;
    }).catch(() => caches.match("/")));
  }
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "Crushed", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || "crushed"
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return clients.openWindow("/");
  }));
});
`);
});

/* ---------------- push alerts: watch selected bats, buzz on HR/RBI ---------------- */
let webpush = null;
try { webpush = require("web-push"); } catch { console.error("[push] web-push not installed — swap package.json to enable alerts"); }
const VAPID_PUB = process.env.VAPID_PUBLIC || "BOQ1auUOA6P44k557eQAlg4W3fNMWNBJYDhV8OIKeihxXNTqCkzYc3qfhluaIUaElbXUqD-Ugb2g1Fid5Wh2XSU";
const VAPID_PRIV = process.env.VAPID_PRIVATE || "W_Gmkk9SgNaFvDx4Vs-ThFMa5LQ4YJftP4HhGywRxm0";
if (webpush) { try { webpush.setVapidDetails("mailto:alerts@crushed.app", VAPID_PUB, VAPID_PRIV); } catch (e) { console.error("[push] vapid:", e.message); webpush = null; } }
const PUSH = { subs: new Map(), players: new Set(), last: new Map() };
function alertDiff(prev, cur, name) {
  const out = [];
  if (prev && cur) {
    if (cur.hr > prev.hr) out.push({ title: name + " HOMERED \ud83d\udca5", body: "HR #" + cur.hrSzn + (cur.rbi > prev.rbi ? " \u00b7 +" + (cur.rbi - prev.rbi) + " RBI" : ""), tag: "hr-" + cur.hrSzn });
    else if (cur.rbi > prev.rbi) out.push({ title: name + " drove in " + (cur.rbi - prev.rbi > 1 ? cur.rbi - prev.rbi + " runs" : "a run") + " \u26be", body: cur.rbi + " RBI today", tag: "rbi-" + cur.rbi });
  }
  return out;
}
app.get("/api/push/pubkey", (q, r) => r.json({ enabled: !!webpush, key: VAPID_PUB }));
app.post("/api/push/subscribe", (req, res) => {
  const s = req.body && req.body.subscription;
  if (!s || !s.endpoint) return res.status(400).json({ ok: false });
  PUSH.subs.set(s.endpoint, s);
  if (Array.isArray(req.body.players)) { PUSH.players = new Set(req.body.players.map(Number)); }
  res.json({ ok: true, watching: [...PUSH.players] });
});
app.post("/api/push/watch", (req, res) => {
  if (Array.isArray(req.body && req.body.players)) PUSH.players = new Set(req.body.players.map(Number));
  res.json({ ok: true, watching: [...PUSH.players] });
});
async function pushAll(msg) {
  if (!webpush) return;
  for (const [ep, sub] of PUSH.subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(msg)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) PUSH.subs.delete(ep); }
  }
}
async function watchLoop() {
  try {
    if (!webpush || !PUSH.subs.size || !PUSH.players.size) return;
    const b = BOARDS.today;
    if (!b || !(b.players || []).length) return;
    const mine = b.players.filter((p) => PUSH.players.has(Number(p.id)));
    if (!mine.length) return;
    const pks = [...new Set(mine.map((p) => p.gamePk))];
    const sc = await getJson(`${STATS}/schedule?sportId=1&date=${b.date}`);
    const liveSet = new Set();
    (sc.dates?.[0]?.games || []).forEach((g) => { if (g.status?.abstractGameState === "Live") liveSet.add(g.gamePk); });
    for (const pk of pks.filter((k) => liveSet.has(k))) {
      const box = await getJson(`${STATS}/game/${pk}/boxscore`).catch(() => null);
      if (!box) continue;
      for (const side of ["away", "home"]) {
        const players = box.teams?.[side]?.players || {};
        for (const p of mine.filter((m) => String(m.gamePk) === String(pk))) {
          const entry = players["ID" + p.id];
          if (!entry) continue;
          const bat = entry.stats?.batting || {};
          const cur = { hr: +(bat.homeRuns || 0), rbi: +(bat.rbi || 0), hrSzn: +(entry.seasonStats?.batting?.homeRuns || 0) };
          const prev = PUSH.last.get(p.id);
          for (const msg of alertDiff(prev, cur, p.name)) await pushAll(msg);
          PUSH.last.set(p.id, cur);
        }
      }
    }
  } catch (e) { console.error("[push] loop:", e.message); }
}
setInterval(watchLoop, 75 * 1000);

/* ---------------- cache ---------------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}
function cachePeek(key, ttlMs) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.t < ttlMs ? hit.v : null;
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
    hc_x: r.hc_x, hc_y: r.hc_y, events: r.events, type: r.type, bb_type: r.bb_type,
    launch_speed: r.launch_speed, launch_angle: r.launch_angle,
    stand: r.stand, p_throws: r.p_throws, description: r.description,
    game_date: r.game_date,
  }));
}
/* small cached packs (a few KB each) */
/* damage a pitcher has allowed, per pitch and overall (from his rows) */
function pitcherDamage(rows) {
  const ab = {}, tb = {}, hrpt = {};
  let hr = 0;
  rows.forEach((r) => {
    if (!r.pitch_type) return;
    if (AB_END.has(r.events)) {
      ab[r.pitch_type] = (ab[r.pitch_type] || 0) + 1;
      tb[r.pitch_type] = (tb[r.pitch_type] || 0) + (TB[r.events] || 0);
    }
    if (r.events === "home_run") { hrpt[r.pitch_type] = (hrpt[r.pitch_type] || 0) + 1; hr++; }
  });
  const vs = {};
  Object.keys(ab).forEach((pt) => { if (ab[pt] >= 15) vs[pt] = +(tb[pt] / ab[pt]).toFixed(3); });
  return { vsPitchAllowed: vs, hrByPtAllowed: hrpt, hrAllowed: hr };
}

const batterPack = (id) => cached(`bpk:${id}`, 12 * H, async () =>
  batterAggregates(await savantRowsRaw(id, "batter")));
function pitcherZoneUsage(rows) {
  const zc = {};
  let tot = 0;
  rows.forEach((r) => {
    const zn = +r.zone;
    if (zn >= 1 && zn <= 9) { zc[zn] = (zc[zn] || 0) + 1; tot++; }
  });
  const out = {};
  if (tot >= 100) Object.keys(zc).forEach((zn) => { out[zn] = zc[zn] / tot; });
  return out;
}
const pitcherPack = (id) => cached(`ppk:${id}`, 12 * H, async () => {
  const rows = await savantRowsRaw(id, "pitcher");
  const dates = [...new Set(rows.map((r) => r.game_date).filter(Boolean))].sort().reverse();
  const lastN = (n) => {
    const keep = new Set(dates.slice(0, n));
    return rows.filter((r) => keep.has(r.game_date));
  };
  return { mix: arsenalFromRows(rows), mixL3: arsenalFromRows(lastN(3)), mixL5: arsenalFromRows(lastN(5)),
    swstr: swstrFromRows(rows), n: rows.length, bbByHand: battedByHand(rows, "stand"), dmg: pitcherDamage(rows), pzones: pitcherZoneUsage(rows) };
});

const person = (id) => cached(`person:${id}`, 240 * H, () =>
  getJson(`${STATS}/people/${id}`).then((j) => j.people?.[0] || {}));

const teamInfo = (id) => cached(`team:${id}`, 240 * H, () =>
  getJson(`${STATS}/teams/${id}`).then((j) => j.teams?.[0] || {}));

function ipToDec(ip) {
  const s = String(ip || "0"), parts = s.split(".");
  return (+parts[0] || 0) + ((+parts[1] || 0) / 3);
}
const seasonPitching = (id) => cached(`sp2:${id}`, 6 * H, async () => {
  const j = await getJson(`${STATS}/people/${id}/stats?stats=season&group=pitching&season=${SEASON}`);
  const s = j.stats?.[0]?.splits?.[0]?.stat || {};
  const ip = ipToDec(s.inningsPitched);
  return {
    ip: +ip.toFixed(1), hr: +(s.homeRuns || 0), era: s.era || "\u2014",
    hr9: ip > 0 ? +((+(s.homeRuns || 0) * 9) / ip).toFixed(2) : null,
  };
});
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

/* batted-ball profile split by the opposing hand: flyballs (Statcast
   bb_type) and barrels per batted ball. keyField = "p_throws" for a
   batter's rows, "stand" for a pitcher's rows. */
function battedByHand(rows, keyField) {
  const out = { L: { bbe: 0, fb: 0, brl: 0 }, R: { bbe: 0, fb: 0, brl: 0 } };
  rows.forEach((r) => {
    if (r.type !== "X") return;
    const k = r[keyField];
    if (k !== "L" && k !== "R") return;
    out[k].bbe++;
    if (r.bb_type === "fly_ball") out[k].fb++;
    if (isBarrel(+r.launch_speed, +r.launch_angle)) out[k].brl++;
  });
  return out;
}

const BSWING = new Set(["swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play", "foul_bunt", "missed_bunt"]);
const BWHIFF = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
function batterAggregates(rows) {
  const vs = {}, z = {}, zL = {}, zR = {};
  const ZSHAPE = () => ({ ab: 0, tb: 0, bbe: 0, brl: 0, hh: 0, hr: 0, sw: 0, wf: 0 });
  let swAll = 0, wfAll = 0;
  const spray = [];
  let bbe = 0, hard = 0, pulled = 0;
  let evSum = 0, evN = 0, laSum = 0, laN = 0, gb = 0, fb = 0, brlAll = 0;
  const bp = {}; // barrels / batted balls by pitch type
  const hrp = {}; // season HR count by pitch type
  const hand = { L: { ab: 0, tb: 0 }, R: { ab: 0, tb: 0 } };
  rows.forEach((r) => {
    if (BSWING.has(r.description)) {
      swAll++;
      const wh = BWHIFF.has(r.description);
      if (wh) wfAll++;
      const zw = +r.zone;
      if (zw >= 1 && zw <= 9) {
        z[zw] = z[zw] || ZSHAPE();
        z[zw].sw++;
        if (wh) z[zw].wf++;
        const zwh = r.p_throws === "L" ? zL : r.p_throws === "R" ? zR : null;
        if (zwh) { zwh[zw] = zwh[zw] || ZSHAPE(); zwh[zw].sw++; if (wh) zwh[zw].wf++; }
      }
    }
    const ev = r.events;
    if (AB_END.has(ev) && r.pitch_type) {
      vs[r.pitch_type] = vs[r.pitch_type] || { ab: 0, tb: 0 };
      vs[r.pitch_type].ab++;
      vs[r.pitch_type].tb += TB[ev] || 0;
      const zone = +r.zone;
      if (zone >= 1 && zone <= 9) {
        z[zone] = z[zone] || ZSHAPE();
        z[zone].ab++;
        z[zone].tb += TB[ev] || 0;
        const zh = r.p_throws === "L" ? zL : r.p_throws === "R" ? zR : null;
        if (zh) {
          zh[zone] = zh[zone] || ZSHAPE();
          zh[zone].ab++;
          zh[zone].tb += TB[ev] || 0;
        }
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
      if (Number.isFinite(lsp)) { evSum += lsp; evN++; }
      if (Number.isFinite(la)) {
        laSum += la; laN++;
        if (la < 10) gb++;
        else if (la >= 25 && la <= 50) fb++;
      }
      if (isBarrel(lsp, la)) brlAll++;
      if (r.pitch_type) {
        bp[r.pitch_type] = bp[r.pitch_type] || { bbe: 0, barrels: 0 };
        bp[r.pitch_type].bbe++;
        if (isBarrel(lsp, la)) bp[r.pitch_type].barrels++;
        if (r.events === "home_run") hrp[r.pitch_type] = (hrp[r.pitch_type] || 0) + 1;
      }
      const bz = +r.zone;
      if (bz >= 1 && bz <= 9) {
        const isB = isBarrel(lsp, la), isH = lsp >= 95, isHr = r.events === "home_run";
        z[bz] = z[bz] || ZSHAPE();
        z[bz].bbe++;
        if (isB) z[bz].brl++;
        if (isH) z[bz].hh++;
        if (isHr) z[bz].hr++;
        const bzh = r.p_throws === "L" ? zL : r.p_throws === "R" ? zR : null;
        if (bzh) {
          bzh[bz] = bzh[bz] || ZSHAPE();
          bzh[bz].bbe++;
          if (isB) bzh[bz].brl++;
          if (isH) bzh[bz].hh++;
          if (isHr) bzh[bz].hr++;
        }
      }
      spray.push({ x: +(+r.hc_x).toFixed(1), y: +(+r.hc_y).toFixed(1), pt: r.pitch_type, ev, d: r.game_date });
    }
  });
  const vsPitch = {};
  Object.entries(vs).forEach(([pt, v]) => { if (v.ab >= 10) vsPitch[pt] = +(v.tb / v.ab).toFixed(3); });
  // windowed batter SLG vs pitch: his last N distinct game dates, honest AB floors
  const bDates = [...new Set(rows.map((r) => r.game_date).filter(Boolean))].sort().reverse();
  const vsWin = (n, abFloor) => {
    const keep = new Set(bDates.slice(0, n));
    const acc = {};
    for (const r of rows) {
      if (!keep.has(r.game_date) || !r.pitch_type) continue;
      const ev = r.events;
      if (!AB_END.has(ev)) continue;
      (acc[r.pitch_type] = acc[r.pitch_type] || { ab: 0, tb: 0 });
      acc[r.pitch_type].ab++;
      acc[r.pitch_type].tb += TB[ev] || 0;
    }
    const out = {};
    Object.entries(acc).forEach(([pt, v]) => { if (v.ab >= abFloor) out[pt] = { slg: +(v.tb / v.ab).toFixed(3), ab: v.ab }; });
    return out;
  };
  const vsPitchL3 = vsWin(3, 2), vsPitchL5 = vsWin(5, 3);
  const zones = [];
  for (let i = 1; i <= 9; i++) zones.push(z[i] && z[i].ab >= 5 ? +(z[i].tb / z[i].ab).toFixed(3) : null);
  const zonesX = z; // rich per-zone counts for the zone-match engine
  spray.sort((a, b) => (a.d < b.d ? 1 : -1));
  const vsHand = {
    L: hand.L.ab >= THRESH.platoonAb ? +(hand.L.tb / hand.L.ab).toFixed(3) : null,
    R: hand.R.ab >= THRESH.platoonAb ? +(hand.R.tb / hand.R.ab).toFixed(3) : null,
  };
  return {
    vsPitch, vsPitchL3, vsPitchL5, zones, zonesX, zonesXBy: { L: zL, R: zR },
    whiffPct: swAll >= 50 ? +((wfAll / swAll) * 100).toFixed(1) : null,
    spray: spray.slice(0, 120).map(({ x, y, pt, ev }) => ({ x, y, pt, ev })),
    hardHitPct: bbe >= 20 ? Math.round((hard / bbe) * 100) : null,
    pullPct: bbe >= 20 ? Math.round((pulled / bbe) * 100) : null,
    avgEV: evN >= 20 ? +(evSum / evN).toFixed(1) : null,
    avgLA: laN >= 20 ? +(laSum / laN).toFixed(1) : null,
    gbPct: laN >= 20 ? Math.round((gb / laN) * 100) : null,
    fbPct: laN >= 20 ? Math.round((fb / laN) * 100) : null,
    brlPct: bbe >= 20 ? +((brlAll / bbe) * 100).toFixed(1) : null,
    barrelsByPt: bp,
    hrByPt: hrp,
    bbByHand: battedByHand(rows, "p_throws"),
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
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = await getJson(url);
        const times = j.hourly?.time || [];
        if (!times.length) throw new Error("empty forecast payload");
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
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await sleep(1500); // one retry before giving up
      }
    }
    console.error(`[weather] ${park}: ${lastErr ? lastErr.message : "unknown failure"}`);
    throw lastErr || new Error("weather fetch failed");
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

/* career totals + career home/away splits for numerology counters */
const careerNums = (id) => cached(`car:${id}`, 24 * H, async () => {
  const out = { hr: null, rbi: null, home: null, away: null };
  try {
    const j = await getJson(`${STATS}/people/${id}/stats?stats=career&group=hitting`);
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (s) { out.hr = +(s.homeRuns || 0); out.rbi = +(s.rbi || 0); }
  } catch { /* leave nulls */ }
  try {
    const j2 = await getJson(`${STATS}/people/${id}/stats?stats=careerStatSplits&group=hitting&sitCodes=h,a`);
    (j2.stats?.[0]?.splits || []).forEach((s) => {
      const code = s.split?.code;
      if (code === "h") out.home = { hr: +(s.stat?.homeRuns || 0), rbi: +(s.stat?.rbi || 0) };
      if (code === "a") out.away = { hr: +(s.stat?.homeRuns || 0), rbi: +(s.stat?.rbi || 0) };
    });
  } catch { /* leave nulls */ }
  return out;
});

/* HR/RBI totals while batting in a specific lineup slot (b1-b9),
   season and career - feeds the batting-spot numerology counters */
const slotSplits = (id, slot) => cached(`ss:${id}:${slot}`, 6 * H, async () => {
  const out = { season: null, career: null };
  const grab = (j) => {
    const s = j?.stats?.[0]?.splits?.[0]?.stat;
    return s ? { hr: +(s.homeRuns || 0), rbi: +(s.rbi || 0) } : null;
  };
  try {
    out.season = grab(await getJson(`${STATS}/people/${id}/stats?stats=statSplits&group=hitting&season=${SEASON}&sitCodes=b${slot}`));
  } catch { /* optional */ }
  try {
    out.career = grab(await getJson(`${STATS}/people/${id}/stats?stats=careerStatSplits&group=hitting&sitCodes=b${slot}`));
  } catch { /* optional */ }
  return out;
});

/* ============================================================
   EASTERN ASTROLOGY — 2026, Year of the Fire Horse.
   Signs use the user's app dialect: Cat in the 4th seat (Vietnamese
   lineage), Ox naming kept. Boundaries come from an explicit Lunar
   New Year table, never a plain Jan 1 cutoff. Tiers for a Horse year:
   friendly (Tiger/Dog trine, Goat secret friend) > Year Rider (Horse,
   own-year amplified energy per the user's school) > neutral >
   enemy (Ox harm, Cat break) > direct clash (Rat, hardest opposition).
   ============================================================ */
const LNY = {
  1970: "02-06", 1971: "01-27", 1972: "02-15", 1973: "02-03", 1974: "01-23",
  1975: "02-11", 1976: "01-31", 1977: "02-18", 1978: "02-07", 1979: "01-28",
  1980: "02-16", 1981: "02-05", 1982: "01-25", 1983: "02-13", 1984: "02-02",
  1985: "02-20", 1986: "02-09", 1987: "01-29", 1988: "02-17", 1989: "02-06",
  1990: "01-27", 1991: "02-15", 1992: "02-04", 1993: "01-23", 1994: "02-10",
  1995: "01-31", 1996: "02-19", 1997: "02-07", 1998: "01-28", 1999: "02-16",
  2000: "02-05", 2001: "01-24", 2002: "02-12", 2003: "02-01", 2004: "01-22",
  2005: "02-09", 2006: "01-29", 2007: "02-18", 2008: "02-07", 2009: "01-26",
  2010: "02-14",
};
const ZODIAC_ANIMALS = ["Rat", "Ox", "Tiger", "Cat", "Dragon", "Snake", "Horse", "Goat", "Monkey", "Rooster", "Dog", "Pig"];
const ZODIAC_ELEMENTS = { 0: "Metal", 1: "Metal", 2: "Water", 3: "Water", 4: "Wood", 5: "Wood", 6: "Fire", 7: "Fire", 8: "Earth", 9: "Earth" };
const HORSE_YEAR_TIERS = {
  Tiger: { tier: 1, band: "friendly", reason: "trine ally of the Horse year" },
  Dog: { tier: 1, band: "friendly", reason: "trine ally of the Horse year" },
  Goat: { tier: 1, band: "friendly", reason: "secret friend of the Horse" },
  Horse: { tier: 2, band: "rider", reason: "Year Rider \u2014 his own Fire Horse year, amplified energy" },
  Dragon: { tier: 3, band: "neutral", reason: "neutral to the Horse year" },
  Snake: { tier: 3, band: "neutral", reason: "neutral to the Horse year" },
  Monkey: { tier: 3, band: "neutral", reason: "neutral to the Horse year" },
  Rooster: { tier: 3, band: "neutral", reason: "neutral to the Horse year" },
  Pig: { tier: 3, band: "neutral", reason: "neutral to the Horse year" },
  Ox: { tier: 4, band: "enemy", reason: "the harm \u2014 enemy of the Horse year" },
  Cat: { tier: 4, band: "enemy", reason: "the break \u2014 enemy of the Horse year" },
  Rat: { tier: 5, band: "clash", reason: "direct clash with the Horse \u2014 hardest opposition" },
};
function zodiacFor(birthDate) {
  if (!birthDate) return null;
  const m = String(birthDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1], mmdd = `${m[2]}-${m[3]}`;
  let effYear = y;
  if (+m[2] <= 2) {
    const lny = LNY[y] || "02-04"; // approx fallback outside table range
    if (mmdd < lny) effYear = y - 1;
  }
  const idx = ((effYear - 1996) % 12 + 12) % 12;
  const sign = ZODIAC_ANIMALS[idx];
  const element = ZODIAC_ELEMENTS[effYear % 10];
  const rel = HORSE_YEAR_TIERS[sign];
  return { sign, element, year: effYear, tier: rel.tier, band: rel.band, reason: rel.reason };
}

/* Full numerology chart: Life Path + Personal Year + Personal Month.
   Personal Year uses the BIRTHDAY-FLIP school (calibrated against the
   user's app: 11/15/1994 in July 2026 = PY 8, PM 6): the new personal
   year begins on the player's birthday, so before it he still rides
   the prior universal year. Masters held un-reduced when they appear
   as components or totals, matching the rest of the system. */
function chartPiece(total) {
  const st = stepsOf(total);
  const v = st[st.length - 1];
  const master = st.some((s) => MASTERS.indexOf(s) !== -1);
  return { v, total, master, path: pathStr(total) };
}
function masterKeep(n) { return MASTERS.indexOf(n) !== -1 ? n : reduceNum(n); }
function chartFor(birthDate, dateISO) {
  if (!birthDate) return null;
  const bm = birthDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const tm = String(dateISO || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!bm || !tm) return null;
  const by = +bm[1], bmo = +bm[2], bda = +bm[3];
  const ty = +tm[1], tmo = +tm[2], tda = +tm[3];
  const yearSum = (y) => String(y).split("").reduce((s, d) => s + +d, 0);
  // Life Path: all-digit pool of YYYYMMDD — the exact math of the
  // existing "Birthday life path" chip, so the two can never disagree
  const lp = chartPiece(String(birthDate).slice(0, 10).replace(/-/g, "").split("").reduce((s, d) => s + +d, 0));
  // Personal Year: birthday-flip — before the birthday, prior year rules
  const hadBirthday = tmo > bmo || (tmo === bmo && tda >= bda);
  const useYear = hadBirthday ? ty : ty - 1;
  const py = chartPiece(masterKeep(bmo) + masterKeep(reduceNum(bda)) + masterKeep(reduceNum(yearSum(useYear))));
  // Personal Month: PY (master preserved) + current calendar month
  const pyVal = MASTERS.indexOf(py.total) !== -1 ? py.total : py.v;
  const pm = chartPiece(pyVal + tmo);
  return { lp, py, pm, pyBasisYear: useYear };
}

function numerologyHits(player, personInfo, splits, career, slotSp, dayNums) {
  const facts = [];
  const push = (label, value) => { if (value != null && !isNaN(value) && value > 0) facts.push({ label, value }); };
  push(`Next HR of the season would be #${player.season.hr + 1}`, player.season.hr + 1);
  push(`Next RBI would be #${player.season.rbi + 1}`, player.season.rbi + 1);
  if (career) {
    if (career.hr != null) push(`Next career HR would be #${career.hr + 1}`, career.hr + 1);
    if (career.rbi != null) push(`Next career RBI would be #${career.rbi + 1}`, career.rbi + 1);
    // only the venue split that matters TONIGHT: home counters at home, road counters on the road
    const side = player.homeGame ? "home" : "away";
    const word = player.homeGame ? "home" : "road";
    const cv = career[side];
    if (cv) {
      push(`Next career ${word} HR would be #${cv.hr + 1}`, cv.hr + 1);
      push(`Next career ${word} RBI would be #${cv.rbi + 1}`, cv.rbi + 1);
    }
  }
  push(`Bats ${ORD(player.slot)}`, player.slot);
  if (slotSp) {
    const so = ORD(player.slot);
    if (slotSp.season) {
      push(`Next HR batting ${so} would be #${slotSp.season.hr + 1}`, slotSp.season.hr + 1);
      push(`Next RBI batting ${so} would be #${slotSp.season.rbi + 1}`, slotSp.season.rbi + 1);
    }
    if (slotSp.career) {
      push(`Next career HR batting ${so} would be #${slotSp.career.hr + 1}`, slotSp.career.hr + 1);
      push(`Next career RBI batting ${so} would be #${slotSp.career.rbi + 1}`, slotSp.career.rbi + 1);
    }
  }
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
/* ============================================================
   SELF-CALIBRATION — a nightly feedback loop. Each day's board is
   snapshotted; once its games go Final, outcomes are graded and a
   small online logistic model re-weights every signal by how well
   it actually predicted homers. Honest learning: it sharpens over
   weeks of graded nights, it does not become psychic. State persists
   to disk, and to the GitHub repo when GITHUB_TOKEN + GITHUB_REPO
   env vars are set (Render's free-tier disk resets on deploys).
   ============================================================ */
const LEARN_FILE = "learn-state.json";
const LEARN_TAGS = ["Crushes top pitch", "Ownage", "Platoon edge", "Reverse split", "Hot bat", "Hard contact", "Pull-heavy", "Hittable arm", "Barrels the mix", "Zone overlap", "HR park", "Carry night", "Traffic ahead", "Power form"];
let LEARN = null;
function freshLearn() {
  const tags = {};
  LEARN_TAGS.forEach((t) => { tags[t] = 0; });
  return { v: 1, days: 0, samples: 0, w: { bias: -2.38, hrPct: 3.0, numer: 0, confirmed: 0, carry: 0, park: 0, tags }, history: [], pending: {} };
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function predictHr(row) {
  const w = LEARN.w;
  let z = w.bias + w.hrPct * (row.hrPct / 100) + w.numer * (Math.min(4, row.numer) / 4)
    + w.confirmed * (row.confirmed ? 1 : 0) + w.carry * ((row.carry || 1) - 1) + w.park * ((row.park || 1) - 1);
  (row.tags || []).forEach((t) => { if (w.tags[t] != null) z += w.tags[t]; });
  return sigmoid(z);
}
function trainOn(rows, results) {
  const lr = 0.08, clip = (v) => Math.max(-2, Math.min(2, v));
  let n = 0, hits = 0, starsN = 0, starsHit = 0;
  for (let epoch = 0; epoch < 3; epoch++) {
    rows.forEach((r) => {
      const out = results[r.id];
      if (!out) return;
      const y = out.hr > 0 ? 1 : 0;
      if (epoch === 0) {
        n++; if (y) hits++;
        if (r.star) { starsN++; if (y) starsHit++; }
      }
      const g = y - predictHr(r);
      const w = LEARN.w;
      w.bias = clip(w.bias + lr * g);
      w.hrPct = clip(w.hrPct + lr * g * (r.hrPct / 100));
      w.numer = clip(w.numer + lr * g * (Math.min(4, r.numer) / 4));
      w.confirmed = clip(w.confirmed + lr * g * (r.confirmed ? 1 : 0));
      w.carry = clip(w.carry + lr * g * ((r.carry || 1) - 1));
      w.park = clip(w.park + lr * g * ((r.park || 1) - 1));
      (r.tags || []).forEach((t) => { if (w.tags[t] != null) w.tags[t] = clip(w.tags[t] + lr * g); });
    });
  }
  return { n, hits, starsN, starsHit };
}
function tagMult(tag) {
  if (!LEARN || LEARN.days < 3) return 1; // no opinions before a few graded days
  const w = LEARN.w.tags[tag] || 0;
  return Math.max(0.4, Math.min(2.2, 1 + w * 1.2));
}
function learnSummary() {
  if (!LEARN) return null;
  const adj = {};
  LEARN_TAGS.forEach((t) => { adj[t] = +tagMult(t).toFixed(2); });
  return { days: LEARN.days, samples: LEARN.samples, tagAdj: adj, last: LEARN.history[0] || null };
}
async function ghLearn(method, content) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  const path = process.env.GITHUB_LEARN_PATH || LEARN_FILE;
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "crushed", Accept: "application/vnd.github+json" };
  if (method === "GET") {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const j = await r.json();
    LEARN_SHA = j.sha;
    return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  }
  const body = { message: "learn-state update [skip render]", content: Buffer.from(content).toString("base64") }; // [skip render] keeps the brain's saves from triggering Render rebuilds
  if (LEARN_SHA) body.sha = LEARN_SHA;
  const r = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (r.ok) { const j = await r.json(); LEARN_SHA = j.content?.sha || LEARN_SHA; }
  return null;
}
let LEARN_SHA = null;
async function loadLearn() {
  try { const gh = await ghLearn("GET"); if (gh && gh.v) { LEARN = gh; console.log(`[learn] loaded from GitHub: day ${LEARN.days}`); return; } } catch { /* try disk */ }
  try { LEARN = JSON.parse(fs.readFileSync(LEARN_FILE, "utf8")); console.log(`[learn] loaded from disk: day ${LEARN.days}`); return; } catch { /* fresh */ }
  LEARN = freshLearn();
  console.log("[learn] fresh state");
}
async function saveLearn() {
  const s = JSON.stringify(LEARN);
  try { fs.writeFileSync(LEARN_FILE, s); } catch { /* disk optional */ }
  try { await ghLearn("PUT", s); } catch { /* github optional */ }
}
function snapshotLearning(b) {
  if (!LEARN) return;
  LEARN.pending[b.date] = (b.players || []).map((p) => ({
    id: p.id, gamePk: p.gamePk, hrPct: p.hrPct || 0,
    numer: (p.numerHits || []).length, confirmed: p.lineup === "confirmed",
    carry: p.carry || 1, park: p.parkHR || 1, tags: p.tags || [], star: !!p.suggested,
  }));
  saveLearn();
}
async function gradeLearning() {
  if (!LEARN) return;
  const today = dayDate("today");
  for (const date of Object.keys(LEARN.pending)) {
    if (date >= today) continue;
    const rows = LEARN.pending[date];
    const pks = [...new Set(rows.map((r) => r.gamePk))];
    let allFinal = true;
    const res = {};
    for (const pk of pks) {
      try {
        const sch = await getJson(`${STATS}/schedule?gamePk=${pk}`);
        const st = sch?.dates?.[0]?.games?.[0]?.status?.abstractGameState;
        if (st !== "Final") { allFinal = false; break; }
        const box = await getJson(`${STATS}/game/${pk}/boxscore`);
        ["away", "home"].forEach((side) => {
          const t = box.teams?.[side];
          if (!t) return;
          Object.values(t.players || {}).forEach((pl) => {
            const bt = pl.stats?.batting;
            if (!bt || pl.person?.id == null) return;
            res[pl.person.id] = { hr: +bt.homeRuns || 0, rbi: +bt.rbi || 0 };
          });
        });
      } catch { allFinal = false; break; }
    }
    if (!allFinal) continue; // postponed / suspended — try again next hour
    const st2 = trainOn(rows, res);
    LEARN.days++; LEARN.samples += st2.n;
    LEARN.history.unshift({ date, n: st2.n, hits: st2.hits, starsN: st2.starsN, starsHit: st2.starsHit });
    LEARN.history = LEARN.history.slice(0, 14);
    delete LEARN.pending[date];
    await saveLearn();
    console.log(`[learn] graded ${date}: ${st2.hits}/${st2.n} homered \u00b7 stars ${st2.starsHit}/${st2.starsN} \u00b7 day ${LEARN.days}`);
  }
}

function starScore(p) {
  return p.hrPct + p.tags.reduce((s, t) => s + THRESH.tagWeight * tagMult(t), 0);
}

async function buildTeamSide(game, sideKey, box, carry, dayNums) {
  const team = game.teams[sideKey].team;
  const oppKey = sideKey === "away" ? "home" : "away";
  const oppSP = game.teams[oppKey].probablePitcher;
  const boxSide = box.teams[sideKey];
  let order = (boxSide.battingOrder || []).map((id, i) => ({
    id, slot: i + 1, name: boxSide.players[`ID${id}`]?.person?.fullName,
  }));
  let lineup = "confirmed";
  if (!order.length) { order = await recentLineup(team.id).catch(() => []); lineup = "projected"; }
  if (!order.length || !oppSP) return [];

  const spPerson = await person(oppSP.id).catch(() => ({}));
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
  for (let ri = 0; ri < order.length; ri += 4) {
    const chunk = await Promise.all(order.slice(ri, ri + 4).map(async (o) => {
      try {
        const s = await seasonHitting(o.id);
        return s && +s.plateAppearances >= 30 ? { ...o, season: s } : null;
      } catch { return null; }
    }));
    chunk.forEach((r) => { if (r) roster.push(r); });
  }
  const out = [];
  const buildOne = async (f) => {
    const [p, rh, bvpRes, splits, career, slotSp] = await Promise.all([
      person(f.id),
      recentHitting(f.id).catch(() => null),
      bvp(f.id, oppSP.id).catch(() => null),
      handSplits(f.id).catch(() => ({})),
      careerNums(f.id).catch(() => null),
      slotSplits(f.id, f.slot).catch(() => null),
    ]);
    const agg = { vsPitch: null, zones: null, spray: null };
    const ahead = order.filter((o) => o.slot < f.slot).slice(-2);
    let settersObp = null;
    if (ahead.length) {
      const obps = (await Promise.all(ahead.map((a) => seasonHitting(a.id).catch(() => null))))
        .filter((s) => s && s.obp).map((s) => +s.obp);
      if (obps.length) settersObp = +(obps.reduce((x, y) => x + y, 0) / obps.length).toFixed(3);
    }
    const sc = score(f.season, f.slot, parkHR, settersObp, carry);
    const player = {
      id: f.id, name: f.name, slot: f.slot, lineup,
      teamId: team.id, teamAbbr: tInfo.abbreviation || team.name,
      gamePk: game.gamePk, oppTeamId: game.teams[oppKey].team.id,
      bats: p.batSide?.code || "?", sp,
      homeGame: sideKey === "home",
      hot: rh && rh.pa >= THRESH.hotPa ? rh.slg : null,
      hardHitPct: null, pullPct: null, barrelsByPt: null, hrByPt: null, vsHand: null,
      season: { hr: +f.season.homeRuns, pa: +f.season.plateAppearances, rbi: +f.season.rbi, g: +f.season.gamesPlayed, obp: f.season.obp, slg: f.season.slg, avg: f.season.avg || null, so: +(f.season.strikeOuts || 0), bb: +(f.season.baseOnBalls || 0), hits: +(f.season.hits || 0), doubles: +(f.season.doubles || 0), triples: +(f.season.triples || 0) },
      ...sc, parkHR, carry: carry != null ? carry : null,
      bvp: bvpRes,
      vsPitch: agg.vsPitch, zones: agg.zones, spray: agg.spray,
      detail: false,
    };
    player.tags = tagsFor(player);
    try {
      player.numerHits = dayNums ? numerologyHits(player, p, splits, career, slotSp, dayNums) : [];
      player.zodiac = zodiacFor(p && p.birthDate);
      player.chart = chartFor(p && p.birthDate, dayNums && dayNums.date);
    } catch (e) {
      player.numerHits = player.numerHits || [];
      console.error(`[chips] ${f.name}: ${e.message}`);
    }
    return player;
  };
  for (let bi = 0; bi < roster.length; bi += 4) {
    const built = await Promise.all(roster.slice(bi, bi + 4).map((f) =>
      buildOne(f).catch((e) => { console.error(`skip ${f.name}: ${e.message}`); return null; })
    ));
    built.forEach((pl) => { if (pl) out.push(pl); });
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
  let gi = 0;
  for (const g of games) {
    gi++;
    if (g.status?.abstractGameState === "Final") continue;
    try {
    console.log(`[assemble:${date}] game ${gi}/${games.length} \u00b7 ${g.gamePk}`);
    const box = await boxscore(g.gamePk).catch(() => ({ teams: { away: { players: {} }, home: { players: {} } } }));
    const awayInfo = await teamInfo(g.teams.away.team.id).catch(() => ({}));
    const homeInfo = await teamInfo(g.teams.home.team.id).catch(() => ({}));
    const wx = await gameWeather(g.venue?.name, g.gameDate).catch(() => null);
    const carry = carryFactor(g.venue?.name, wx);
    outGames.push({
      gamePk: g.gamePk,
      gameDate: g.gameDate || null,
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
    } catch (e) { console.error(`[assemble:${date}] skip game ${g.gamePk}: ${e.message}`); }
  }
  // re-inherit Statcast from every already-scouted pack (zone build,
  // enrichment, or manual taps filled the cache) — instant, zero fetches,
  // and it survives the 30-min lineup reassembly that creates fresh objects
  players.forEach((p) => {
    const pk = cachePeek(`bpk:${p.id}`, 12 * H);
    if (pk) {
      if (p.avgEV == null) p.avgEV = pk.avgEV;
      if (p.avgLA == null) p.avgLA = pk.avgLA;
      if (p.gbPct == null) p.gbPct = pk.gbPct;
      if (p.fbPct == null) p.fbPct = pk.fbPct;
      if (p.brlPct == null) p.brlPct = pk.brlPct;
      if (p.whiffPct == null) p.whiffPct = pk.whiffPct;
    }
  });
  return { date, generatedAt: new Date().toISOString(),
    numerology: dayNums,
    thresholds: THRESH,
    learning: learnSummary(),
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
  if (b._enriching) return;
  b._enriching = true;
  try { await enrichDayInner(day, b); } finally { b._enriching = false; }
}
async function enrichDayInner(day, b) {
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
        p.vsPitch = agg.vsPitch; p.vsPitchL3 = agg.vsPitchL3; p.vsPitchL5 = agg.vsPitchL5; p.zones = agg.zones; p.spray = agg.spray;
        p.hardHitPct = agg.hardHitPct; p.pullPct = agg.pullPct;
        p.barrelsByPt = agg.barrelsByPt; p.hrByPt = agg.hrByPt; p.vsHand = agg.vsHand;
        p.avgEV = agg.avgEV; p.avgLA = agg.avgLA; p.gbPct = agg.gbPct; p.fbPct = agg.fbPct; p.brlPct = agg.brlPct; p.whiffPct = agg.whiffPct;
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
  if (day === "today") snapshotLearning(b);
  console.log(`[enrich:${day}] Statcast signals applied to stars`);
}

function warmDay(day) {
  if (assembling[day]) return assembling[day];
  assembling[day] = assembleBoard(dayDate(day))
    .then((b) => {
      BOARDS[day] = b;
      console.log(`[warm:${day}] board ready: ${b.players.length} players, ${b.games.length} games`);
      enrichDay(day).catch((e) => console.error(`[enrich:${day}] failed:`, e.message)); // background
    })
    .catch((e) => console.error(`[warm:${day}] failed:`, e.message))
    .finally(() => { assembling[day] = null; });
  return assembling[day];
}
async function warm() { await warmDay("today"); warmDay("tomorrow"); }

/* heal boards whose outdoor games are missing weather (fetch failed at
   assembly): retry every cycle and patch the board + carries in place */
async function weatherBackfill() {
  for (const day of ["today", "tomorrow"]) {
    const b = BOARDS[day];
    if (!b || !b.games) continue;
    for (const g of b.games) {
      if (g.weather || !STADIA[g.park] || ROOFED.has(g.park)) continue;
      try {
        const wx = await gameWeather(g.park, g.start || `${b.date}T23:00:00Z`);
        if (!wx) continue;
        g.weather = { tempF: wx.tempF, windMph: wx.windMph, relDeg: wx.relDeg, label: wx.roof ? "Roof" : wx.label };
        const c = carryFactor(g.park, wx);
        if (c != null) {
          g.carry = c;
          (b.players || []).forEach((p) => { if (String(p.gamePk) === String(g.gamePk)) p.carry = c; });
        }
        console.log(`[weather] backfilled ${g.park} (${day})`);
      } catch { /* logged inside gameWeather; retried next cycle */ }
    }
  }
}

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
    res.json({ mix: pk.mix, mixL3: pk.mixL3, mixL5: pk.mixL5, swstr: pk.swstr });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* lazy Statcast detail (spray, zones, pitch-type SLG) for any batter —
   used when a non-featured lineup player is opened */
app.get("/api/detail/:batterId", async (req, res) => {
  try {
    res.json(await batterPack(req.params.batterId));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* recent-form box: one game-log fetch aggregated into L7/L15/L30 windows */
const recentBox = (id) => cached(`rb:${id}`, 6 * H, async () => {
  const j = await getJson(`${STATS}/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  const logs = (j.stats?.[0]?.splits || []).slice();
  logs.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const fmt = (v) => v.toFixed(3).replace(/^0\./, ".");
  function agg(n) {
    const rows = logs.slice(0, n);
    if (!rows.length) return null;
    const s = { pa: 0, ab: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, so: 0, hbp: 0, sf: 0 };
    rows.forEach((r) => {
      const x = r.stat || {};
      s.pa += +x.plateAppearances || 0; s.ab += +x.atBats || 0; s.h += +x.hits || 0;
      s.d += +x.doubles || 0; s.t += +x.triples || 0; s.hr += +x.homeRuns || 0;
      s.rbi += +x.rbi || 0; s.bb += +x.baseOnBalls || 0; s.so += +x.strikeOuts || 0;
      s.hbp += +x.hitByPitch || 0; s.sf += +x.sacFlies || 0;
    });
    const tb = s.h + s.d + 2 * s.t + 3 * s.hr;
    const obpDen = s.ab + s.bb + s.hbp + s.sf;
    return {
      g: rows.length, pa: s.pa, hr: s.hr, rbi: s.rbi, h: s.h,
      xbh: s.d + s.t + s.hr, bb: s.bb, so: s.so,
      avg: s.ab ? fmt(s.h / s.ab) : "\u2014",
      obp: obpDen ? fmt((s.h + s.bb + s.hbp) / obpDen) : "\u2014",
      slg: s.ab ? fmt(tb / s.ab) : "\u2014",
      ops: s.ab && obpDen ? fmt((s.h + s.bb + s.hbp) / obpDen + tb / s.ab) : "\u2014",
    };
  }
  const last = logs.slice(0, 30);
  const perGame = [];
  for (const r of last) {
    const x = r.stat || {};
    let opp = "";
    try {
      if (r.opponent?.id) opp = (await teamInfo(r.opponent.id)).abbreviation || r.opponent?.name || "";
      else opp = r.opponent?.name || "";
    } catch { opp = r.opponent?.name || ""; }
    perGame.push({
      d: String(r.date || "").slice(5), // MM-DD
      opp, home: !!r.isHome,
      ab: +x.atBats || 0, r: +x.runs || 0, h: +x.hits || 0,
      hr: +x.homeRuns || 0, rbi: +x.rbi || 0, bb: +x.baseOnBalls || 0, so: +x.strikeOuts || 0,
    });
  }
  return { 3: agg(3), 5: agg(5), 10: agg(10), 7: agg(7), 15: agg(15), 25: agg(25), 30: agg(30), games: perGame };
});
/* full season splits: batter vs LHP/RHP, or pitcher vs LHB/RHB */
const fullSplits = (type, id) => cached(`fs:${type}:${id}`, 6 * H, async () => {
  const group = type === "pitcher" ? "pitching" : "hitting";
  const j = await getJson(`${STATS}/people/${id}/stats?stats=statSplits&group=${group}&season=${SEASON}&sitCodes=vl,vr`);
  const out = { vl: null, vr: null };
  (j.stats?.[0]?.splits || []).forEach((s) => {
    const code = s.split?.code;
    if (code !== "vl" && code !== "vr") return;
    const x = s.stat || {};
    out[code] = {
      pa: +x.plateAppearances || +x.battersFaced || 0,
      ab: +x.atBats || 0, h: +x.hits || 0, hr: +x.homeRuns || 0,
      rbi: +x.rbi || 0, bb: +x.baseOnBalls || 0, so: +x.strikeOuts || 0,
      avg: x.avg || "\u2014", obp: x.obp || "\u2014", slg: x.slg || "\u2014", ops: x.ops || "\u2014",
    };
  });
  return out;
});
app.get("/api/splits/:type/:id", async (req, res) => {
  try {
    const type = req.params.type === "pitcher" ? "pitcher" : "batter";
    const out = JSON.parse(JSON.stringify(await fullSplits(type, req.params.id)));
    try {
      const hb = type === "batter"
        ? (await batterPack(req.params.id)).bbByHand
        : (await pitcherPack(req.params.id)).bbByHand;
      const pct = (n, d) => (d >= 15 ? Math.round((n / d) * 100) : null); // 15-BBE floor per hand
      ["vl", "vr"].forEach((code) => {
        if (!out[code]) return;
        const v = hb && hb[code === "vl" ? "L" : "R"];
        out[code].fbPct = v ? pct(v.fb, v.bbe) : null;
        out[code].brlPct = v ? pct(v.brl, v.bbe) : null;
      });
    } catch { /* MLB splits still useful if the Statcast layer fails */ }
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ============================================================
   GOD MODE — the engine's own ten for the day. A judgment model,
   deliberately separate from the boards: raw thump, "due" droughts,
   two-week heat, matchup gut reads, and a deterministic daily hunch
   dial (seeded by the date, so the list is fixed for the day).
   ============================================================ */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function godPicks(board) {
  const date = board.date;
  const pool = (board.players || []).filter((p) => p.season && p.season.pa >= 100);
  pool.forEach((p) => { p._pr = (p.season.hr || 0) / Math.max(1, p.season.pa); });
  const cands = pool.slice()
    .sort((a, b) => (b._pr * (b.parkHR || 1) * (b.carry || 1)) - (a._pr * (a.parkHR || 1) * (a.carry || 1)))
    .slice(0, 25);
  const scored = [];
  for (const p of cands) {
    let drought = null, l15 = null;
    try {
      const rb = await recentBox(p.id);
      const g = rb.games || [];
      drought = g.findIndex((x) => x.hr > 0);
      if (drought === -1) drought = g.length;
      l15 = rb[15];
    } catch { /* judge without the logs */ }
    const reasons = [];
    let s = p._pr * 500;
    if ((p.season.hr || 0) >= 20) { s += 4; reasons.push(`${p.season.hr} bombs already \u2014 elite thump`); }
    if (drought != null && drought >= 5 && drought <= 15 && p._pr >= 0.035) {
      s += Math.min(15, drought * 1.2);
      reasons.push(`${drought} games since his last homer \u2014 that streak breaks`);
    } else if (drought != null && drought <= 1 && p._pr >= 0.04) {
      s += 3; reasons.push("homered in his last game and the swing is loud");
    }
    if (l15 && parseFloat(l15.slg) >= 0.5) { s += 4; reasons.push("bat has been scorching for two weeks"); }
    const opp = p.bats === "S" || (p.bats === "L" && p.sp?.hand === "R") || (p.bats === "R" && p.sp?.hand === "L");
    if (opp) s += 3;
    if (p.sp && p.sp.swstr != null && p.sp.swstr < 10) { s += 4; reasons.push(`${p.sp.name} doesn't miss bats \u2014 everything gets put in play`); }
    if ((p.carry || 1) >= 1.15) { s += 4; reasons.push("the ball is flying in this weather"); }
    if ((p.parkHR || 1) >= 1.15) { s += 3; reasons.push("the park plays small"); }
    if (p.bvp && p.bvp.ab >= 8 && parseFloat(p.bvp.slg) >= 0.6) { s += 3; reasons.push("has hurt this arm before"); }
    const hunch = mulberry32(hash32(date + ":" + p.id))() * 6;
    s += hunch;
    if (hunch > 4.5) reasons.push("and the gut says tonight");
    scored.push({ p, s, reasons });
  }
  scored.sort((a, b) => b.s - a.s);
  const out = [], perGame = {};
  for (const c of scored) {
    if (out.length >= 10) break;
    const g = String(c.p.gamePk);
    if ((perGame[g] || 0) >= 2) continue;
    perGame[g] = (perGame[g] || 0) + 1;
    out.push({
      id: c.p.id, name: c.p.name, teamAbbr: c.p.teamAbbr, slot: c.p.slot, gamePk: c.p.gamePk,
      sp: c.p.sp ? { name: c.p.sp.name, hand: c.p.sp.hand } : null,
      hrPct: c.p.hrPct,
      reason: c.reasons.slice(0, 2).join(" \u00b7 ") || "pure instinct \u2014 the profile smells like a homer",
    });
  }
  return out;
}
app.get("/api/learning", (req, res) => {
  res.json(LEARN ? { days: LEARN.days, samples: LEARN.samples, w: LEARN.w, history: LEARN.history, pendingDates: Object.keys(LEARN.pending) } : { days: 0 });
});

app.get("/api/god", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ warming: true, picks: [] });
    const picks = await cached(`god:${date}`, 3 * H, async () => godPicks(b));
    res.json({ date, picks });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* live game state for the Live Game tab: score bug, count/outs, bases,
   current matchup, and the current at-bat's pitch locations. */
async function gamedayState(gamePk) {
  const ls = await getJson(`${STATS}/game/${gamePk}/linescore`);
  const pbp = await getJson(`${STATS}/game/${gamePk}/playByPlay`);
  let status = {};
  try {
    const sch = await getJson(`${STATS}/schedule?gamePk=${gamePk}`);
    status = sch?.dates?.[0]?.games?.[0]?.status || {};
  } catch { /* status optional */ }
  const plays = pbp.allPlays || [];
  const cur = plays.length ? plays[plays.length - 1] : null;
  let lastDesc = "";
  for (let i = plays.length - 1; i >= 0; i--) {
    if (plays[i].about?.isComplete && plays[i].result?.description) { lastDesc = plays[i].result.description; break; }
  }
  let szTop = 3.4, szBot = 1.6;
  const pitches = [];
  if (cur) {
    (cur.playEvents || []).forEach((e) => {
      if (!e.isPitch || !e.pitchData) return;
      const c = e.pitchData.coordinates || {};
      if (e.pitchData.strikeZoneTop) szTop = +e.pitchData.strikeZoneTop;
      if (e.pitchData.strikeZoneBottom) szBot = +e.pitchData.strikeZoneBottom;
      pitches.push({
        x: c.pX != null ? +c.pX : null,
        z: c.pZ != null ? +c.pZ : null,
        mph: e.pitchData.startSpeed ? +(+e.pitchData.startSpeed).toFixed(1) : null,
        code: e.details?.type?.code || "",
        type: e.details?.type?.description || "",
        result: e.details?.description || "",
      });
    });
  }
  const lineups = { away: [], home: [] };
  try {
    const box = await getJson(`${STATS}/game/${gamePk}/boxscore`);
    ["away", "home"].forEach((side) => {
      const t = box.teams?.[side];
      if (!t) return;
      (t.battingOrder || []).forEach((pid) => {
        const pl = t.players?.["ID" + pid];
        if (!pl) return;
        const b = pl.stats?.batting || {};
        lineups[side].push({
          id: pid, name: pl.person?.fullName || "", pos: pl.position?.abbreviation || "",
          ab: +b.atBats || 0, r: +b.runs || 0, h: +b.hits || 0, rbi: +b.rbi || 0,
          bb: +b.baseOnBalls || 0, so: +b.strikeOuts || 0,
          avg: pl.seasonStats?.batting?.avg || "",
        });
      });
    });
  } catch { /* lineup box optional */ }
  const off = ls.offense || {}, def = ls.defense || {};
  return {
    lineups,
    status: status.abstractGameState || "", detail: status.detailedState || "",
    inning: ls.currentInning || null, half: ls.isTopInning ? "top" : "bottom",
    outs: ls.outs || 0, balls: ls.balls || 0, strikes: ls.strikes || 0,
    awayRuns: ls.teams?.away?.runs ?? 0, homeRuns: ls.teams?.home?.runs ?? 0,
    bases: { first: !!off.first, second: !!off.second, third: !!off.third },
    batter: off.batter ? { id: off.batter.id, name: off.batter.fullName } : null,
    pitcher: def.pitcher ? { id: def.pitcher.id, name: def.pitcher.fullName } : null,
    onDeck: off.onDeck?.fullName || "", inHole: off.inHole?.fullName || "",
    lastPlay: lastDesc, szTop, szBot, pitches,
  };
}
app.get("/api/gameday/:gamePk", async (req, res) => {
  try {
    res.json(await cached(`gd:${req.params.gamePk}`, 12 * 1000, () => gamedayState(req.params.gamePk)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* Pitchers' Weak Spots: tonight's starters ranked most-exploitable
   first — damage profile + bleeder pitch + weak side + the opposing
   batters from the board who best exploit each arm. */
/* pick the opposing batters best matched to THIS pitcher's specific
   weaknesses: his weak batter-side, his bleeder pitch, then raw power */
/* pitcher's season line vs each opposing batting-order slot (b1-b9);
   a slot is "weak" when he's been hurt there over a real sample */
const pitcherSlotSplits = (id) => cached(`pslot:${id}`, 6 * H, async () => {
  const codes = "b1,b2,b3,b4,b5,b6,b7,b8,b9";
  const j = await getJson(`${STATS}/people/${id}/stats?stats=statSplits&group=pitching&season=${SEASON}&sitCodes=${codes}`);
  const out = [];
  (j.stats?.[0]?.splits || []).forEach((s) => {
    const code = s.split?.code || "";
    const m = code.match(/^b([1-9])$/);
    if (!m) return;
    const x = s.stat || {};
    const bf = +(x.battersFaced || x.plateAppearances || 0);
    const opsN = x.ops && x.ops !== "-.--" ? parseFloat(x.ops) : null;
    out.push({
      slot: +m[1], bf, hr: +(x.homeRuns || 0),
      ops: x.ops || "\u2014",
      weak: !!(bf >= 15 && opsN != null && opsN >= 0.8),
    });
  });
  out.sort((a, b) => a.slot - b.slot);
  return out;
});

/* the opposing lineup in batting order, flagged wherever a batter sits
   in one of this pitcher's weak spots (slot / side / bleeder pitch) */
/* stamp day-number alignments onto a pitcher's slot rows (cloned:
   the splits cache is per-pitcher, the flags are per-day) */
function annotateSlots(slots, daySet) {
  const set = daySet || [];
  return (slots || []).map((s) => ({
    ...s,
    slotAligned: set.indexOf(reduceNum(s.slot)) !== -1,
    hrAligned: set.indexOf(reduceNum(s.hr + 1)) !== -1,
    nextHr: s.hr + 1,
  }));
}

function buildWeakLineup(facing, slots, bleed, weakSide, slotHrById) {
  const weakBySlot = {};
  (slots || []).forEach((s) => { if (s.weak) weakBySlot[s.slot] = s; });
  return facing.slice().sort((a, b) => (a.slot || 9) - (b.slot || 9)).map((p) => {
    const matches = [];
    const ws = weakBySlot[p.slot];
    if (ws) matches.push(`his weak slot \u00b7 ${ws.ops} OPS`);
    if (weakSide) {
      const sideChar = weakSide.side === "LHB" ? "L" : "R";
      if (p.bats === sideChar || p.bats === "S") matches.push("weak side");
    }
    if (bleed) {
      const slg = p.vsPitch ? p.vsPitch[bleed.pt] : null;
      if (slg != null && slg >= 0.55) matches.push(slg.toFixed(3).replace(/^0\./, ".") + " vs bleeder");
      else if (p.hrByPt && (p.hrByPt[bleed.pt] || 0) >= 3) matches.push(p.hrByPt[bleed.pt] + " HR off bleeder");
    }
    return {
      id: p.id, name: p.name, slot: p.slot, bats: p.bats, lineup: p.lineup,
      hrPct: p.hrPct, star: !!p.suggested,
      cross: !!(p.suggested && p.numerHits && p.numerHits.length),
      slotHr: slotHrById && slotHrById[p.id] != null ? slotHrById[p.id] : null,
      slotAligned: !!(p.numerHits && p.numerHits.some((h) => (h.label || "").indexOf(`Next HR batting ${ORD(p.slot)}`) === 0)),
      matches,
    };
  });
}

function pickTargets(facing, bleed, weakSide) {
  const scored = facing.map((p) => {
    let fit = p.hrPct || 0;
    const why = [];
    if (weakSide) {
      const sideChar = weakSide.side === "LHB" ? "L" : "R";
      if (p.bats === sideChar || p.bats === "S") {
        fit += 12;
        why.push((p.bats === "S" ? "SHB" : weakSide.side) + " into his weak side");
      }
    }
    if (bleed) {
      const slg = p.vsPitch ? p.vsPitch[bleed.pt] : null;
      if (slg != null && slg >= 0.55) { fit += 10; why.push(slg.toFixed(3).replace(/^0\./, ".") + " vs his bleeder"); }
      const hrs = p.hrByPt ? p.hrByPt[bleed.pt] || 0 : 0;
      if (hrs >= 3) { fit += 6; why.push(hrs + " HR off that pitch"); }
    }
    return { p, fit, why };
  });
  scored.sort((a, b) => b.fit - a.fit);
  return scored.slice(0, 3).map((s) => ({
    id: s.p.id, name: s.p.name, hrPct: s.p.hrPct,
    star: !!s.p.suggested, cross: !!(s.p.suggested && s.p.numerHits && s.p.numerHits.length),
    why: s.why.slice(0, 2).join(" \u00b7 "),
  }));
}

/* ============================================================
   ZONE MATCH — our adaptation of a zone-comparison metric: the
   batter's per-zone quality (SLG damage, Barrel%, HR rate, Hard-Hit%)
   weighted by THIS pitcher's zone usage, scored 0-100 as favorability
   vs the batter's own overall baseline (50 = his normal self), then
   blended HR-first: 35% HR rate, 30% Barrel, 20% Hard-Hit, 15% Damage.
   Honest substitution: "Damage (SLG)" replaces the reference site's
   Contact column — our feed doesn't retain per-zone whiff detail. */
function zoneMatch(zones, pzones, abFloor, bbeFloor, swFloor) {
  if (!zones || !pzones || !Object.keys(pzones).length) return null;
  let totAb = 0, totTb = 0, totBbe = 0, totBrl = 0, totHh = 0, totHr = 0, totSw = 0, totWf = 0;
  Object.values(zones).forEach((v) => {
    if (!v || typeof v !== "object") return;
    totAb += v.ab || 0; totTb += v.tb || 0;
    totBbe += v.bbe || 0; totBrl += v.brl || 0; totHh += v.hh || 0; totHr += v.hr || 0;
    totSw += v.sw || 0; totWf += v.wf || 0;
  });
  if (totAb < (abFloor || 60) || totBbe < (bbeFloor || 40)) return null; // real baselines only
  const hasCon = totSw >= (swFloor || 50);
  const base = {
    dmg: totTb / totAb,
    brl: totBrl / totBbe,
    hh: totHh / totBbe,
    hr: totHr / totBbe,
    con: hasCon ? 1 - totWf / totSw : 0,
  };
  const acc = { dmg: 0, brl: 0, hh: 0, hr: 0, con: 0 };
  let wSum = 0;
  Object.entries(pzones).forEach(([zn, w]) => {
    const v = zones[zn];
    wSum += w;
    // thin per-zone samples fall back to the batter's baseline (ratio 1)
    const zdmg = v && v.ab >= 5 ? v.tb / v.ab : base.dmg;
    const zbbe = v && v.bbe >= 4 ? v.bbe : 0;
    acc.dmg += w * zdmg;
    acc.brl += w * (zbbe ? v.brl / zbbe : base.brl);
    acc.hh += w * (zbbe ? v.hh / zbbe : base.hh);
    acc.hr += w * (zbbe ? v.hr / zbbe : base.hr);
    acc.con += w * (v && v.sw >= 6 ? 1 - v.wf / v.sw : base.con);
  });
  if (!wSum) return null;
  const score = (wc, b) => {
    if (!b) return 50;
    return Math.max(0, Math.min(100, Math.round(50 * (wc / wSum) / b)));
  };
  const dmg = score(acc.dmg, base.dmg), brl = score(acc.brl, base.brl);
  const hh = score(acc.hh, base.hh), hr = score(acc.hr, base.hr);
  const con = hasCon ? score(acc.con, base.con) : 50;
  const zs = Math.round(0.30 * hr + 0.25 * brl + 0.20 * hh + 0.15 * con + 0.10 * dmg);
  return { con, dmg, brl, hh, hr, zs };
}
const ZONEB = {}; // date -> { building, list, ts } — built in background, served instantly
let ZONE_ACTIVE = false; // one build at a time: the free tier cannot afford two
/* ============================================================
   HR PROP ODDS — live sportsbook lines via The Odds API (free key
   from the-odds-api.com set as ODDS_API_KEY in Render env; optional
   ODDS_REGION, default "us"). We take each player's BEST available
   Over 0.5 HR price across books, match names to board ids
   (accent/suffix-proof), and cache 2h to respect the free quota. */
const ODDS_KEY = process.env.ODDS_API_KEY || "";
const ODDS_REGION = process.env.ODDS_REGION || "us";
function normName(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\./g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}
async function fetchDayOdds(b) {
  const events = await getJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${ODDS_KEY}`);
  const byName = {};
  for (const ev of events || []) {
    try {
      const o = await getJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${ev.id}/odds?apiKey=${ODDS_KEY}&regions=${ODDS_REGION}&markets=batter_home_runs&oddsFormat=american`);
      (o.bookmakers || []).forEach((bk) => {
        (bk.markets || []).forEach((mk) => {
          if (mk.key !== "batter_home_runs") return;
          (mk.outcomes || []).forEach((out) => {
            if (out.name !== "Over" || +out.point !== 0.5) return;
            const key = normName(out.description);
            if (!byName[key] || +out.price > +byName[key].odds) byName[key] = { odds: +out.price, book: bk.title };
          });
        });
      });
    } catch { /* one event's odds missing — keep going */ }
  }
  const map = {};
  (b.players || []).forEach((p) => {
    const hit = byName[normName(p.name)];
    if (hit) map[p.id] = hit;
  });
  console.log(`[odds] matched ${Object.keys(map).length} players`);
  return map;
}
app.get("/api/odds", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    if (!ODDS_KEY) return res.json({ enabled: false });
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ enabled: true, warming: true, players: {} });
    const map = await cached(`odds:${date}`, 2 * H, () => fetchDayOdds(b));
    res.json({ enabled: true, players: map, fetchedAt: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* Hand-split selection: prefer the batter's zone profile vs TONIGHT'S
   pitcher's hand (his actual platoon slice — decisive for switch-hitters);
   fall back to the pooled profile when the split is too thin to trust. */
function zoneMatchFor(bpk, spHand, pzones) {
  if (!bpk || !pzones) return null;
  const split = (spHand === "L" || spHand === "R") && bpk.zonesXBy && bpk.zonesXBy[spHand];
  if (split) {
    const m = zoneMatch(split, pzones, 40, 25, 30);
    if (m) return { ...m, basis: "vs" + spHand };
  }
  const m = zoneMatch(bpk.zonesX, pzones);
  return m ? { ...m, basis: "all" } : null;
}
app.get("/api/zone", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ warming: true, players: [] });
    let st = ZONEB[date];
    if (st && !st.building && Date.now() - st.ts > 2 * H) st = null; // stale — rebuild
    if (!st) {
      if (ZONE_ACTIVE) {
        // another date is building — answer instantly, the client's retry will land here again
        return res.json({ date, building: true, players: [], queued: true });
      }
      ZONE_ACTIVE = true;
      st = ZONEB[date] = { building: true, list: [], ts: Date.now() };
      (async () => {
        try {
          const pool = (b.players || []).filter((p) => p.sp && p.sp.id && p.season && p.season.pa >= 60);
          console.log(`[zone:${date}] building ${pool.length} matchups (2-wide, serialized)`);
          for (let i = 0; i < pool.length; i += 2) {
            const chunk = await Promise.all(pool.slice(i, i + 2).map(async (p) => {
              try {
                const [bpk, ppk] = await Promise.all([batterPack(p.id), pitcherPack(p.sp.id)]);
                if (bpk) {
                  // the pack is in hand — feed the board so every bat's
                  // Statcast fields fill as the build marches (free: same fetch)
                  p.avgEV = bpk.avgEV; p.avgLA = bpk.avgLA;
                  p.gbPct = bpk.gbPct; p.fbPct = bpk.fbPct;
                  p.brlPct = bpk.brlPct; p.whiffPct = bpk.whiffPct;
                }
                const m = zoneMatchFor(bpk, p.sp && p.sp.hand, ppk && ppk.pzones);
                return m ? { id: p.id, ...m } : null;
              } catch { return null; }
            }));
            chunk.forEach((r) => { if (r) st.list.push(r); });
            if (i && i % 40 === 0) console.log(`[zone:${date}] ${i}/${pool.length} \u00b7 ${st.list.length} scored`);
          }
        } catch (e) { console.error(`[zone:${date}] failed:`, e.message); }
        finally { st.building = false; st.ts = Date.now(); ZONE_ACTIVE = false; console.log(`[zone:${date}] ready: ${st.list.length} scored`); }
      })();
    }
    res.json({ date, building: st.building, players: st.list });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* Career HR calendar for the milestone panel: every career game log
   folded into monthly / day-of-week counts, next-milestone progress. */
function hrCalFromEntries(entries, todayISO) {
  const byMonth = {}, byDow = {};
  let career = 0, thisYear = 0;
  const ty = +String(todayISO).slice(0, 4);
  entries.forEach((e) => {
    const hr = +e.hr || 0;
    if (!hr || !e.date) return;
    const d = new Date(e.date + "T12:00:00Z");
    const mo = d.getUTCMonth() + 1, dow = d.getUTCDay();
    byMonth[mo] = (byMonth[mo] || 0) + hr;
    byDow[dow] = (byDow[dow] || 0) + hr;
    career += hr;
    if (+e.date.slice(0, 4) === ty) thisYear += hr;
  });
  const next = (Math.floor(career / 5) + 1) * 5;
  const td = new Date(todayISO + "T12:00:00Z");
  return {
    career, thisYear, byMonth, byDow,
    next, away: next - career,
    monthToday: td.getUTCMonth() + 1, dowToday: td.getUTCDay(),
  };
}
const hrCalendar = (id) => cached(`hrcal:${id}`, 12 * H, async () => {
  // scan from the player's actual MLB debut year, not a guessed window —
  // a fixed lookback silently amputates early seasons (the Goldschmidt bug)
  let floor = SEASON - 25;
  try {
    const p = await person(id);
    if (p && p.mlbDebutDate) floor = +String(p.mlbDebutDate).slice(0, 4);
  } catch { /* fall back to the wide window */ }
  const entries = [];
  let empty = 0;
  for (let y = SEASON; y >= floor; y--) {
    try {
      const j = await getJson(`${STATS}/people/${id}/stats?stats=gameLog&group=hitting&season=${y}`);
      const splits = j.stats?.[0]?.splits || [];
      if (!splits.length) { if (y < SEASON) empty++; if (empty >= 2) break; continue; }
      empty = 0;
      splits.forEach((s) => entries.push({ date: s.date, hr: +(s.stat?.homeRuns || 0) }));
    } catch { /* season unavailable — keep going */ }
  }
  return hrCalFromEntries(entries, dayDate("today"));
});
/* Last-25-games OPS across the slate for the OPS mode toggle */
const ADVW = {}; // date -> { building, list, ts } — L-window aggregates for the whole slate
app.get("/api/windows", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ warming: true, players: [] });
    let st = ADVW[date];
    if (st && !st.building && Date.now() - st.ts > 0.75 * H) st = null;
    if (!st) {
      st = ADVW[date] = { building: true, list: [], ts: Date.now() };
      (async () => {
        try {
          const pool = (b.players || []).filter((p) => p.season && p.season.pa >= 30);
          for (let i = 0; i < pool.length; i += 4) {
            const chunk = await Promise.all(pool.slice(i, i + 4).map(async (p) => {
              try {
                const rb = await recentBox(p.id);
                if (!rb) return null;
                return { id: p.id, w: { 3: rb[3] || null, 5: rb[5] || null, 10: rb[10] || null, 15: rb[15] || null } };
              } catch { return null; }
            }));
            chunk.forEach((r) => { if (r) st.list.push(r); });
          }
        } catch (e) { console.error(`[windows:${date}] failed:`, e.message); }
        finally { st.building = false; st.ts = Date.now(); console.log(`[windows:${date}] ready: ${st.list.length}`); }
      })();
    }
    res.json({ date, building: st.building, players: st.list });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
const OPS25B = {}; // date -> { building, list, ts }
app.get("/api/ops25", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ warming: true, players: [] });
    let st = OPS25B[date];
    if (st && !st.building && Date.now() - st.ts > 0.75 * H) st = null;
    if (!st) {
      st = OPS25B[date] = { building: true, list: [], ts: Date.now() };
      (async () => {
        try {
          const pool = (b.players || []).filter((p) => p.season && p.season.pa >= 100);
          for (let i = 0; i < pool.length; i += 4) {
            const chunk = await Promise.all(pool.slice(i, i + 4).map(async (p) => {
              try {
                const rb = await recentBox(p.id);
                const w = rb && rb[25];
                if (!w || w.ops === "\u2014") return null;
                return { id: p.id, ops: parseFloat(w.ops), g: w.g, pa: w.pa, hr: w.hr };
              } catch { return null; }
            }));
            chunk.forEach((r) => { if (r) st.list.push(r); });
          }
        } catch (e) { console.error(`[ops25:${date}] failed:`, e.message); }
        finally { st.building = false; st.ts = Date.now(); console.log(`[ops25:${date}] ready: ${st.list.length}`); }
      })();
    }
    res.json({ date, building: st.building, players: st.list });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/hrcal/:id", async (req, res) => {
  try { res.json(await hrCalendar(req.params.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/weak", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const b = BOARDS[day];
    if (!b || b.date !== date || !(b.players || []).length) return res.json({ warming: true, pitchers: [] });
    const out = await cached(`weak:${date}`, 0.5 * H, async () => {
      const byPk = {};
      (b.games || []).forEach((g) => { byPk[g.gamePk] = g; });
      const sps = {};
      (b.players || []).forEach((p) => {
        if (!p.sp || !p.sp.id) return;
        if (!sps[p.sp.id]) sps[p.sp.id] = { id: p.sp.id, name: p.sp.name, hand: p.sp.hand, gamePk: p.gamePk, oppAbbr: p.teamAbbr, facing: [] };
        sps[p.sp.id].facing.push(p);
      });
      const list = [];
      for (const sp of Object.values(sps)) {
        const g = byPk[sp.gamePk] || {};
        let pk = null, spl = null, sea = null;
        try { pk = await pitcherPack(sp.id); } catch { /* judge without statcast */ }
        try { spl = await fullSplits("pitcher", sp.id); } catch { /* optional */ }
        try { sea = await seasonPitching(sp.id); } catch { /* optional */ }
        const bh = pk && pk.bbByHand ? pk.bbByHand : null;
        const bbe = bh ? bh.L.bbe + bh.R.bbe : 0;
        const brl = bh && bbe >= 30 ? Math.round(((bh.L.brl + bh.R.brl) / bbe) * 100) : null;
        const fb = bh && bbe >= 30 ? Math.round(((bh.L.fb + bh.R.fb) / bbe) * 100) : null;
        let bleed = null;
        if (pk && pk.dmg) {
          Object.keys(pk.dmg.vsPitchAllowed).forEach((pt) => {
            const slg = pk.dmg.vsPitchAllowed[pt];
            if (!bleed || slg > bleed.slg) bleed = { pt, slg, hr: pk.dmg.hrByPtAllowed[pt] || 0 };
          });
        }
        let weakSide = null;
        if (spl) {
          const L = spl.vl, R = spl.vr;
          const ops = (x) => (x && x.ops !== "\u2014" ? parseFloat(x.ops) : null);
          const lo = ops(L), ro = ops(R);
          if (lo != null || ro != null) {
            weakSide = (lo || 0) >= (ro || 0)
              ? { side: "LHB", ops: L.ops, hr: L.hr }
              : { side: "RHB", ops: R.ops, hr: R.hr };
          }
        }
        const hr9 = sea && sea.hr9 != null ? sea.hr9 : 1.1;
        const swstr = pk && pk.swstr != null ? pk.swstr : 10;
        const score = hr9 * 12 + (brl != null ? brl : 7) * 1.2 + (fb != null ? fb : 36) * 0.25
          + Math.max(0, 11 - swstr) * 2.2 + ((g.carry || 1) - 1) * 30 + ((g.parkHR || 1) - 1) * 20;
        const targets = pickTargets(sp.facing, bleed, weakSide);
        let slots = [];
        try { slots = await pitcherSlotSplits(sp.id); } catch { /* optional */ }
        slots = annotateSlots(slots, b.numerology && b.numerology.set);
        const slotHrById = {};
        for (const fp of sp.facing) {
          try {
            const ss = await slotSplits(fp.id, fp.slot);
            slotHrById[fp.id] = ss && ss.season ? ss.season.hr : null;
          } catch { slotHrById[fp.id] = null; }
        }
        const lineup = buildWeakLineup(sp.facing, slots, bleed, weakSide, slotHrById);
        list.push({
          id: sp.id, name: sp.name, hand: sp.hand,
          team: g.away === sp.oppAbbr ? g.home : g.away, opp: sp.oppAbbr,
          park: g.park, carry: g.carry, gamePk: sp.gamePk,
          hr9: sea ? sea.hr9 : null, hrAllowed: sea ? sea.hr : (pk && pk.dmg ? pk.dmg.hrAllowed : null),
          era: sea ? sea.era : "\u2014", swstr: pk ? pk.swstr : null, brl, fb,
          bleed, weakSide, targets, slots, lineup, score: +score.toFixed(1),
        });
      }
      list.sort((a, z) => z.score - a.score);
      return list;
    });
    res.json({ date, pitchers: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* live scoring plays across the slate: every HR/RBI play from MLB's
   play-by-play feeds, merged newest-first. Cached 25s so any number of
   viewers costs one pull per game per refresh window. */
app.get("/api/live", async (req, res) => {
  const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
  const date = dayDate(day);
  try {
    const plays = await cached(`liveplays:${date}`, 25 * 1000, async () => {
      let games = BOARDS[day] && BOARDS[day].date === date ? BOARDS[day].games : null;
      if (!games || !games.length) {
        const sc = await getJson(`${STATS}/schedule?sportId=1&date=${date}`);
        games = [];
        for (const d of sc.dates || []) {
          for (const g of d.games || []) {
            try {
              games.push({
                gamePk: g.gamePk,
                away: (await teamInfo(g.teams.away.team.id)).abbreviation || "AWY",
                home: (await teamInfo(g.teams.home.team.id)).abbreviation || "HOM",
              });
            } catch { /* skip */ }
          }
        }
      }
      const out = [];
      for (const g of games) {
        try {
          const pbp = await getJson(`${STATS}/game/${g.gamePk}/playByPlay`);
          (pbp.allPlays || []).forEach((p) => {
            if (!p.about?.isScoringPlay) return;
            let playId = null;
            (p.playEvents || []).forEach((ev) => { if (ev.playId) playId = ev.playId; });
            out.push({
              gamePk: g.gamePk, away: g.away, home: g.home,
              inning: p.about?.inning, half: p.about?.halfInning,
              event: p.result?.event || "",
              desc: p.result?.description || "",
              batterId: p.matchup?.batter?.id || null,
              batter: p.matchup?.batter?.fullName || "",
              rbi: +(p.result?.rbi || 0),
              hr: p.result?.event === "Home Run",
              awayScore: p.result?.awayScore, homeScore: p.result?.homeScore,
              t: p.about?.endTime || "",
              playId,
            });
          });
        } catch { /* game feed unavailable; skip */ }
      }
      out.sort((a, b) => (a.t < b.t ? 1 : -1));
      return out;
    });
    res.json({ date, plays });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* resolve a play UUID to MLB's hosted MP4 so the client can play it
   inline. We read Savant's own replay page for the play and pull the
   sporty-clips CDN URL it embeds; the video stays hosted by MLB. */
const clipUrl = (playId, gamePk) => cached(`clip:${playId}`, 6 * H, async () => {
  /* 1) Film Room media gateway: JSON, resolves a play UUID directly to
     MLB-hosted MP4s. Primary source. */
  try {
    const q = `query{mediaPlayback(ids:["${playId}"],languagePreference:EN,idType:PLAY_ID){feeds{playbacks{name url}}}}`;
    const r = await fetch("https://fastball-gateway.mlb.com/graphql?query=" + encodeURIComponent(q));
    if (r.ok) {
      const j = await r.json();
      const feeds = j?.data?.mediaPlayback?.[0]?.feeds || [];
      for (const f of feeds) {
        const pbs = f.playbacks || [];
        const best = pbs.find((p) => /mp4/i.test(p.name || "") && /\.mp4/.test(p.url || ""))
          || pbs.find((p) => /\.mp4/.test(p.url || ""));
        if (best) return best.url;
      }
    }
  } catch { /* fall through */ }
  /* 2) Official Stats API game content: highlight items carry MP4
     playbacks; match the item to this play's UUID. */
  try {
    if (gamePk) {
      const j = await getJson(`${STATS}/game/${gamePk}/content`);
      const items = j?.highlights?.highlights?.items || [];
      for (const it of items) {
        const ids = [it.guid, it.mediaPlaybackId, it.playId].filter(Boolean).map(String);
        if (!ids.some((x) => x.indexOf(playId) !== -1)) continue;
        const best = (it.playbacks || []).find((p) => /\.mp4/.test(p.url || ""));
        if (best) return best.url;
      }
    }
  } catch { /* fall through */ }
  /* 3) Savant replay page as last resort */
  const r2 = await fetch(`https://baseballsavant.mlb.com/sporty-videos?playId=${encodeURIComponent(playId)}`);
  if (r2.ok) {
    const page = await r2.text();
    const m = page.match(/https:\/\/sporty-clips\.mlb\.com\/[^"'\s<>]+\.mp4/);
    if (m) return m[0];
  }
  throw new Error("clip not posted yet");
});
app.get("/api/clip/:playId", async (req, res) => {
  try {
    res.json({ url: await clipUrl(req.params.playId, req.query.gamePk) });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get("/api/recent/:batterId", async (req, res) => {
  try {
    res.json(await recentBox(req.params.batterId));
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
  loadLearn().then(() => gradeLearning());
  setInterval(gradeLearning, 60 * 60 * 1000); // grade finished days hourly
  setTimeout(weatherBackfill, 90 * 1000);
  setInterval(weatherBackfill, 10 * 60 * 1000); // heal missing outdoor weather
  warm();
  setInterval(warm, 30 * 60 * 1000); // lineups firm up through the afternoon
});
