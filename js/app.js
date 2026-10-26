import { FraudEngine, Traffic, KINDS, RuleSet, DEFAULT_RULES, CITIES } from "../src/index.js";
import { $, esc, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, hexA } from "./pro.js";

const OK = "#34f5c5", BAD = "#ff5c8a", WARN = "#ffb547", ACC2 = "#7c5cff", MUTED = "#5f6884", mono = "JetBrains Mono, monospace";
const tr = new Traffic({ seed: 11, fraud: 2.5 }), E = new FraudEngine({ profiles: (id) => tr.profile(id) });
const inr = (v) => "₹" + Math.round(v).toLocaleString("en-IN"), inrK = (v) => (v >= 1e7 ? "₹" + (v / 1e7).toFixed(2) + " Cr" : v >= 1e5 ? "₹" + (v / 1e5).toFixed(1) + " L" : inr(v));
const clock = () => new Date((tr.t + 19800) * 1000).toISOString().slice(11, 19);
const log = new LogView($("#log"), 200), L = (h) => log.html(h, clock());

// ---------- state ----------
let pulses = [], arcs = [], ringLines = [], latest = null, pinned = null, inspDirty = false;
const campaigns = new Map(), txCamp = new Map(), cityVol = {};
let win = { n: 0 }, snaps = [];
E.on((ev) => {
  if (ev.type === "decision") {
    const { tx, res } = ev; win.n++; cityVol[tx.city] = (cityVol[tx.city] || 0) + 1;
    pulses.push({ city: tx.city, d: res.decision, amt: tx.amount, t: 1, j: [Math.random() - 0.5, Math.random() - 0.5], fraud: tx._fraud });
    if (res.ctx.travel.km > 500 && res.ctx.travel.from && res.ctx.travel.from !== tx.city) arcs.push({ a: res.ctx.travel.from, b: tx.city, d: res.decision, t: 1 });
    if (tx.device && tx.device.startsWith("dev-ring")) ringLines.push({ city: tx.city, d: res.decision, t: 1 });
    if (res.decision !== "approve") { latest = { tx, res }; inspDirty = true; }
    const cid = txCamp.get(tx.id); if (cid) { const c = campaigns.get(cid); c.done++; c[res.decision]++; c.amt += tx.amount; if (res.decision !== "approve") c.stopped += tx.amount; if (c.done === c.n) finish(c); }
    if (res.decision === "decline" && tx.amount >= 20000 && !cid) L(`<span class="bad">DECLINE</span> ${inr(tx.amount)} ${tx.mcc} · ${tx.city} <span class="dim">${esc(res.by)} · score ${res.score}</span>`);
  } else if (ev.type === "label") {
    if (ev.fraud && ev.decision === "approve" && ev.source === "chargeback") { const h = E.hist.get(ev.id); if (h && h.amount > 3000) L(`<span class="warn">CHARGEBACK</span> ${inr(h.amount)} ${h.tx.mcc} slipped through <span class="dim">${KINDS[h.tx._kind] || "fraud"} · the model ${E.learn ? "learns from it" : "is frozen"}</span>`); }
  }
});
function finish(c) {
  const cls = c.stopped / c.amt > 0.8 ? "ok" : c.stopped / c.amt > 0.4 ? "warn" : "bad";
  L(`<span class="${cls}">${KINDS[c.kind].toUpperCase()}</span> ${c.n - c.approve}/${c.n} attempts stopped <span class="dim">${inr(c.stopped)} of ${inr(c.amt)} blocked · ${c.decline} declined · ${c.review} to review</span>`);
}
function attack(kind, quiet) {
  const txs = tr.attack(kind, tr.t), id = "c" + campaigns.size; campaigns.set(id, { kind, n: txs.length, done: 0, approve: 0, review: 0, decline: 0, amt: 0, stopped: 0 }); for (const x of txs) txCamp.set(x.id, id);
  if (!quiet) { L(`<span class="acc">ATTACK</span> ${KINDS[kind]} launched <span class="dim">${txs.length} transactions over the next ${Math.round(txs.at(-1).t - tr.t)} s</span>`); toast(`${KINDS[kind]}: watch the map and the review queue`); }
}
for (const b of document.querySelectorAll("[data-atk]")) b.onclick = () => attack(b.dataset.atk);

// ---------- KPIs + charts ----------
const kp = new Kpis($("#kpis"), [
  { key: "tps", label: "Tx / s", tone: "acc", fmt: (v) => v.toFixed(0) }, { key: "dec", label: "Declined", fmt: (v) => Math.round(v).toLocaleString() },
  { key: "q", label: "Review queue", fmt: (v) => Math.round(v) }, { key: "p", label: "Decline prec", fmt: (v) => (v * 100).toFixed(1) + "%" },
  { key: "r", label: "Recall", fmt: (v) => (v * 100).toFixed(1) + "%" }, { key: "saved", label: "Fraud blocked", fmt: (v) => inrK(v) },
]);
const prc = new Chart($("#pr"), { series: [{ label: "decline precision", color: "--accent" }, { label: "recall", color: ACC2 }], min: 0, max: 1, points: 90, area: false, fmtY: (v) => (v * 100).toFixed(0) + "%" });
function drawHist() {
  const { ctx, w, h: H } = fit($("#hist")); ctx.clearRect(0, 0, w, H);
  const nb = 20, g = new Array(nb).fill(0), f = new Array(nb).fill(0); for (const x of E.hist.values()) if (x.label != null) (x.label ? f : g)[Math.min(nb - 1, Math.floor(x.score / 50))]++;
  const pad = 26, bw = (w - pad - 6) / nb, top = 8, bot = H - 32, mx = Math.log10(1 + Math.max(1, ...g, ...f)), Y = (v) => bot - (Math.log10(1 + v) / mx) * (bot - top);
  ctx.font = `500 10px ${mono}`; ctx.fillStyle = MUTED; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of [1, 10, 100, 1000, 10000]) { if (Math.log10(1 + v) > mx) break; const y = Y(v); ctx.fillText(v >= 1000 ? v / 1000 + "k" : v, pad - 4, y); ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w, y); ctx.stroke(); }
  for (let i = 0; i < nb; i++) { const x = pad + i * bw; ctx.fillStyle = hexA(OK, 0.55); ctx.fillRect(x + 1, Y(g[i]), bw / 2 - 1, bot - Y(g[i])); ctx.fillStyle = hexA(BAD, 0.85); ctx.fillRect(x + bw / 2, Y(f[i]), bw / 2 - 1, bot - Y(f[i])); }
  const X = (s) => pad + (s / 1000) * (w - pad - 6);
  for (const [th, c, lab] of [[E.th.review, WARN, "review"], [E.th.decline, BAD, "decline"]]) { ctx.strokeStyle = c; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(th), top); ctx.lineTo(X(th), bot); ctx.stroke(); ctx.setLineDash([]); }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = MUTED; ctx.fillText("0", pad, bot + 13); ctx.textAlign = "right"; ctx.fillText("1000", w - 6, bot + 13); ctx.textAlign = "center"; ctx.fillText("score", (pad + w) / 2, bot + 13);
  ctx.textAlign = "left"; ctx.fillStyle = OK; ctx.fillText("■ genuine", pad, H - 2); ctx.fillStyle = BAD; ctx.fillText("■ fraud", pad + 78, H - 2); ctx.fillStyle = WARN; ctx.fillText("┆ thresholds", pad + 140, H - 2);
}

// ---------- map ----------
const INDIA = [[68.2, 23.7], [70, 20.9], [72.8, 21.1], [72.9, 19], [73.4, 16], [74.5, 13], [76, 10], [77.5, 8.1], [78.4, 9.2], [79.9, 10.3], [80.3, 13.4], [80.1, 15.8], [82.3, 16.6], [84.8, 19.2], [86.9, 20.8], [87, 21.6], [88.7, 21.6], [89, 22.5], [88.2, 24], [88.5, 26.4], [89.8, 26], [92, 25], [92.6, 22], [93.4, 23.8], [94.6, 25.2], [95.3, 26.9], [97.4, 28.2], [95.5, 29], [92.3, 27.8], [89.6, 28], [88.1, 27.9], [86, 27.8], [84, 27.6], [81, 28.9], [80, 30.5], [78.7, 31.8], [79, 32.5], [78.2, 34.6], [77, 35.5], [75.5, 36], [74, 35], [73.8, 34.3], [74.5, 32.5], [75.3, 32.2], [74.4, 31], [73.9, 30], [72.9, 28.8], [71, 27.9], [70, 27], [69.5, 26.2], [70.5, 25], [68.8, 24.3]];
let LY = null;
function layout(w, H) {
  const top = 40, bot = 34, narrow = w < 600, cx = w / 2, cy = top + (H - top - bot) / 2, s = Math.min((w * (narrow ? 0.56 : 0.42)) / 30, ((H - top - bot) * (narrow ? 0.6 : 0.78)) / 30);
  const P = (lat, lon) => [cx + (lon - 82.5) * s, cy - (lat - 21) * s * 1.06], pos = {};
  for (const [name, g] of Object.entries(CITIES)) {
    if (g.country === "IN") { pos[name] = P(g.lat, g.lon); continue; }
    const a = Math.atan2(g.lat - 21, (g.lon - 78) * Math.cos((21 * Math.PI) / 180)), rx = w / 2 - (narrow ? 44 : 70), ry = (H - top - bot) / 2 - 20;
    pos[name] = [cx + Math.cos(a) * rx, cy - Math.sin(a) * ry];
  }
  return { P, pos, narrow, hub: [narrow ? w - 56 : w - 120, top + (narrow ? 34 : 40)], top, bot };
}
const dcol = (d) => (d === "decline" ? BAD : d === "review" ? WARN : OK);
function draw(dt = 0) {
  const { ctx, w, h: H } = fit($("#map")); ctx.clearRect(0, 0, w, H); LY = layout(w, H); const { P, pos, narrow, hub } = LY;
  ctx.beginPath(); INDIA.forEach(([lo, la], i) => { const [x, y] = P(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
  const g = ctx.createRadialGradient(w / 2, H / 2, 10, w / 2, H / 2, Math.max(w, H) / 2); g.addColorStop(0, hexA(OK, 0.08)); g.addColorStop(1, hexA(ACC2, 0.03)); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = hexA(OK, 0.25); ctx.lineWidth = 1; ctx.stroke();
  // cross-border links
  for (const [n, gg] of Object.entries(CITIES)) if (gg.country !== "IN") { const [x, y] = pos[n]; ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(w / 2, H / 2); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); }
  // arcs: card location jumps
  arcs = arcs.filter((a) => (a.t -= dt / 3) > 0);
  for (const a of arcs) { const p = pos[a.a], q = pos[a.b]; if (!p || !q) continue; const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2 - Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.25; ctx.strokeStyle = hexA(dcol(a.d), 0.85 * a.t); ctx.lineWidth = a.d === "approve" ? 1 : 2; ctx.beginPath(); ctx.moveTo(...p); ctx.quadraticCurveTo(mx, my, ...q); ctx.stroke(); const k = 1 - a.t, bx = (1 - k) ** 2 * p[0] + 2 * (1 - k) * k * mx + k * k * q[0], by = (1 - k) ** 2 * p[1] + 2 * (1 - k) * k * my + k * k * q[1]; ctx.fillStyle = dcol(a.d); ctx.beginPath(); ctx.arc(bx, by, 2.5, 0, 7); ctx.fill(); }
  // card-testing bot hub
  ringLines = ringLines.filter((r) => (r.t -= dt / 4) > 0);
  if (ringLines.length) { ctx.fillStyle = hexA(BAD, 0.9); ctx.font = `700 10px ${mono}`; ctx.textAlign = "center"; const bl = narrow ? "BOT · 1 device" : "BOT · 1 device · 1 IP", bw = ctx.measureText(bl).width / 2; ctx.fillText(bl, Math.max(bw + 4, Math.min(w - bw - 4, hub[0])), hub[1] - 14); ctx.strokeStyle = BAD; ctx.lineWidth = 1.5; ctx.beginPath(); for (let i = 0; i < 6; i++) { const an = (i / 6) * Math.PI * 2; const x = hub[0] + Math.cos(an) * 9, y = hub[1] + Math.sin(an) * 9; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke(); for (const r of ringLines) { const q = pos[r.city]; ctx.strokeStyle = hexA(dcol(r.d), 0.6 * r.t); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(...hub); ctx.lineTo(...q); ctx.stroke(); } }
  // cities
  ctx.textBaseline = "middle";
  for (const [n, [x, y]] of Object.entries(pos)) {
    const v = cityVol[n] || 0, r = 2.5 + Math.min(7, Math.sqrt(v) * 0.5), foreign = CITIES[n].country !== "IN";
    ctx.fillStyle = foreign ? hexA(ACC2, 0.9) : hexA(OK, 0.9); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    if (narrow && !foreign && !["Mumbai", "Delhi", "Bengaluru", "Kolkata", "Kolhapur", "Chennai"].includes(n)) continue;
    ctx.font = `500 ${narrow ? 9.5 : 10.5}px ${mono}`; ctx.fillStyle = foreign ? "#b9a8ff" : "#c9d3e8"; const lbl = n === "NewYork" ? "New York" : n, lw = ctx.measureText(lbl).width; let right = x > w / 2 + 10 || (!foreign && ["Kolkata", "Hyderabad", "Delhi", "Chennai"].includes(n)); if (!right && x - r - 5 - lw < 2) right = true; if (right && x + r + 5 + lw > w - 2) right = false; ctx.textAlign = right ? "left" : "right"; ctx.fillText(lbl, x + (right ? r + 5 : -r - 5), y);
  }
  // pulses
  pulses = pulses.filter((p) => (p.t -= dt * (p.d === "approve" ? 1.6 : 0.55)) > 0); if (pulses.length > 500) pulses.splice(0, pulses.length - 500);
  for (const p of pulses) { const q = pos[p.city]; if (!q) continue; const x = q[0] + p.j[0] * 18, y = q[1] + p.j[1] * 18, c = dcol(p.d);
    if (p.d === "approve") { ctx.fillStyle = hexA(c, 0.5 * p.t); ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill(); }
    else { const rr = 4 + (1 - p.t) * 16; ctx.strokeStyle = hexA(c, p.t); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke(); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); if (p.amt >= 10000 && p.t > 0.4) { ctx.font = `700 10px ${mono}`; ctx.textAlign = "center"; ctx.fillStyle = hexA(c, p.t); ctx.fillText(inrK(p.amt), x, y - rr - 6); } } }
  ctx.font = `500 10px ${mono}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const items = [["● approve", OK], ["◯ review", WARN], ["◯ decline", BAD], ["⌒ location jump", "#c9d3e8"]]; let lx = 14; for (const [t, c] of items) { ctx.fillStyle = c; ctx.fillText(t, lx, H - 12); lx += ctx.measureText(t).width + 14; if (lx > w - 80) break; }
}

// ---------- inspector + queue ----------
function inspect({ tx, res }) {
  const f = res.ctx, d = res.decision;
  const reasons = res.reasons.map((r) => r.kind === "rule" ? `<div class="r">● ${esc(r.name)}${r.action === "score" ? ` <span class="dim">score ${r.delta > 0 ? "+" : ""}${r.delta}</span>` : ` <span class="dim">→ ${r.action}</span>`}</div>` : `<div class="mdl">◆ ${esc(r.why)} <span class="dim">+${r.contrib}</span></div>`).join("") || `<div class="mdl">nothing unusual</div>`;
  $("#insp").innerHTML = `<div class="hd"><span class="dec ${d}">${d.toUpperCase()}</span><b>${inr(tx.amount)}</b><span class="dim">${esc(tx.mcc)} · ${esc(tx.city)} · ${tx.channel}</span></div>
    <div class="dim">${esc(tx.card)} · ${esc(tx.id)} · decided by ${esc(res.by)} · ${res.us} µs</div>
    <div class="meter"><i style="width:${res.score / 10}%"></i><b style="left:${E.th.review / 10}%"></b><b style="left:${E.th.decline / 10}%"></b></div>
    <div>score <b>${res.score}</b> <span class="dim">(model ${res.modelScore})</span>${tx._fraud != null ? ` · <span class="${tx._fraud ? "bad" : "ok"}">truth: ${tx._fraud ? KINDS[tx._kind] : "genuine"}</span>` : ""}</div>
    <div class="rs" style="margin-top:6px">${reasons}</div>
    <div class="ft"><span>card 10m/1h <b>${f.card.count_10m}/${f.card.count_1h}</b></span><span>amount z <b>${f.card.z}</b></span><span>device <b>${f.device.new ? "new" : "known"}</b> · cards <b>${f.device.cards_24h}</b></span><span>IP cards 1h <b>${f.ip.cards_1h}</b></span><span>travel <b>${f.travel.km} km</b></span><span>speed <b>${f.travel.kmh.toLocaleString()} km/h</b></span></div>`;
}
function renderQueue() {
  const open = E.openCases().slice(-7).reverse(); $("#qn").textContent = E.openCases().length + " open";
  $("#queue").innerHTML = open.length ? open.map((c) => `<div class="row" data-id="${c.id}"><div class="m">${inr(c.tx.amount)} ${esc(c.tx.mcc)} · ${esc(c.tx.city)}<small>${c.score} · ${esc(c.reasons[0]?.name || "model")}</small></div><button class="btn sm x bad" data-v="1">Fraud</button><button class="btn sm x" data-v="0">Genuine</button></div>`).join("") : `<div class="empty">Queue is clear. Flagged transactions that need a human land here.</div>`;
  for (const row of document.querySelectorAll("#queue .row")) {
    row.onclick = (ev) => { const id = row.dataset.id, c = E.cases.get(id), h = E.hist.get(id); if (ev.target.dataset.v != null) { const fr = ev.target.dataset.v === "1"; E.resolve(id, fr); L(`<span class="${fr ? "bad" : "ok"}">ANALYST</span> ${id} marked ${fr ? "fraud" : "genuine"} <span class="dim">${c.tx._fraud === fr ? "correct" : "wrong call"} · ${E.learn ? "model updated" : "learning off"}</span>`); renderQueue(); return; }
      const res = lastRes.get(id); if (c && res) { pinned = { tx: c.tx, res }; $("#insw").textContent = "pinned · click to unpin"; inspect(pinned); } };
  }
}
const lastRes = new Map(); E.on((ev) => { if (ev.type === "decision" && ev.res.decision === "review") { lastRes.set(ev.tx.id, ev.res); if (lastRes.size > 500) lastRes.delete(lastRes.keys().next().value); } });
$("#insw").onclick = () => { pinned = null; $("#insw").textContent = "latest flagged"; if (latest) inspect(latest); };

// ---------- policy ----------
const ta = $("#rules"); ta.value = DEFAULT_RULES;
function lint() { try { const r = new RuleSet(ta.value), w = r.lint(FraudEngine.fields()); ta.classList.remove("err"); $("#rstat").className = "rstat " + (w.length ? "warn" : "ok"); $("#rstat").textContent = w.length ? `⚠ ${w[0].rule}: ${w[0].msg}` : `✓ ${r.rules.length} rules`; return r; } catch (e) { ta.classList.add("err"); $("#rstat").className = "rstat bad"; $("#rstat").textContent = "✗ " + e.message; return null; } }
ta.addEventListener("input", lint);
$("#apply").onclick = () => { if (!lint()) return toast("Fix the rule error first"); const r = E.setRules(ta.value); $("#rver").textContent = r.version; L(`<span class="acc">RULES</span> ${r.rules.length} rules live <span class="dim">${r.version} · no deploy, next transaction uses them</span>`); toast("Rules applied to live traffic"); };
$("#reset").onclick = () => { ta.value = DEFAULT_RULES; $("#apply").click(); };
$("#rth").oninput = () => { E.th.review = +$("#rth").value; if (E.th.review > E.th.decline) { E.th.decline = E.th.review; $("#dth").value = E.th.review; } $("#rv").textContent = E.th.review; $("#dv").textContent = E.th.decline; drawHist(); };
$("#dth").oninput = () => { E.th.decline = +$("#dth").value; if (E.th.decline < E.th.review) { E.th.review = E.th.decline; $("#rth").value = E.th.decline; } $("#rv").textContent = E.th.review; $("#dv").textContent = E.th.decline; drawHist(); };
$("#learn").onchange = () => { E.learn = $("#learn").checked; L(`<span class="acc">MODEL</span> online learning ${E.learn ? "on" : "off"}`); };
$("#rver").textContent = E.rules.version; lint();

// ---------- loop ----------
let acc = 0, qAcc = 0;
function tick(dt, ui = true) {
  const { txs, labels } = tr.step(dt); for (const x of txs) E.score(x); for (const l of labels) E.label(l.id, l.fraud);
  acc += dt; qAcc += dt;
  if (ui && inspDirty && !pinned && qAcc > 0.4) { inspect(latest); inspDirty = false; }
  if (ui && qAcc > 0.6) { renderQueue(); qAcc = 0; }
  if (acc >= 1) {
    const o = E.outcomes; snaps.push({ ...o }); if (snaps.length > 61) snaps.shift(); const a = snaps[0], dTp = o.tp - a.tp, dFp = o.fp - a.fp, dFn = o.fn - a.fn;
    const dD = o.dtp - a.dtp, dDf = o.dfp - a.dfp, p = dD + dDf ? dD / (dD + dDf) : 1, r = dTp + dFn ? dTp / (dTp + dFn) : 1;
    if (ui) { prc.push(p, r); drawHist(); const m = E.metrics(); $("#aucp").textContent = "AUC " + (isFinite(m.auc) ? m.auc.toFixed(3) : "—"); }
    kp.set({ tps: win.n / acc, dec: E.stats.decline, q: E.openCases().length, p, r, saved: E.stats.blocked });
    kp.tone("p", p < 0.6 ? "bad" : p < 0.8 ? "warn" : "ok"); kp.tone("r", r < 0.6 ? "bad" : r < 0.8 ? "warn" : "ok");
    win.n = 0; acc = 0; for (const k in cityVol) cityVol[k] *= 0.6;
    $("#clock").textContent = `${clock()} IST · ${E.stats.scored.toLocaleString()} scored · ${E.stats.labels.toLocaleString()} labels`;
  }
}
for (let i = 0; i < 1200; i++) tick(0.1, i > 1100); // prewarm 2 min so labels and charts have history
pulses = []; arcs = []; ringLines = []; log.clear();
L(`<span class="acc">LIVE</span> ${tr.customers.length.toLocaleString()} cards · ${E.rules.rules.length} rules + 14-feature model <span class="dim">labels arrive 20–90 s later as chargebacks</span>`);
const loop = new Loop((dt) => { tick(dt); draw(dt); });
bindLoop(loop, $("#sim")); draw(); drawHist(); loop.start();
setTimeout(() => attack("card-testing"), 1500);
setTimeout(() => attack("skimming"), 5000);
setTimeout(() => attack("ato"), 8000);
addEventListener("resize", () => { draw(); drawHist(); });
