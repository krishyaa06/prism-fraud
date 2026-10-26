import { Series, Distinct, Welford, km } from "./window.js";
import { RuleSet, DEFAULT_RULES } from "./rules.js";
import { Logistic, vectorize, FEATURES, auc, confusion } from "./model.js";
import { WEIGHTS } from "./weights.js";

const H = 3600, D = 86400;
const RANK = { approve: 0, review: 1, decline: 2 };
/**
 * Real-time fraud decisioning: features from sliding windows, an analyst rule set and an online
 * logistic model, combined into approve / review / decline with human-readable reasons.
 */
export class FraudEngine {
  constructor({ rules = DEFAULT_RULES, model, review = 450, decline = 800, maxHistory = 50000, learn = true, profiles = null } = {}) {
    this.profiles = profiles; // optional feature-store lookup: (cardId) => profile | null, consulted the first time a card is seen
    this.rules = new RuleSet(rules); this.model = model || new Logistic(WEIGHTS);
    this.th = { review, decline }; this.maxHistory = maxHistory; this.learn = learn;
    this.cards = new Map(); this.devices = new Map(); this.ips = new Map(); this.hist = new Map(); this.cases = new Map();
    this.stats = { scored: 0, approve: 0, review: 0, decline: 0, labels: 0, amount: 0, blocked: 0 };
    this.outcomes = { tp: 0, fp: 0, dtp: 0, dfp: 0, tn: 0, fn: 0, savedAmt: 0, lostAmt: 0, frictionAmt: 0 }; this.subs = [];
  }
  on(fn) { this.subs.push(fn); return () => (this.subs = this.subs.filter((f) => f !== fn)); }
  emit(e) { for (const f of this.subs) f(e); }
  setRules(src) { const r = new RuleSet(src); this.rules = r; return r; }
  /** Seed a card from historical data: home country, tier, known devices, spend distribution (log amounts) and last location. */
  registerCard({ id, home = "IN", tier = "standard", opened, devices = [], spend, last }) {
    const c = this.card(id); Object.assign(c, { home, tier, opened: opened ?? c.opened });
    const t = last?.t ?? opened ?? 0; for (const d of devices) c.devices.add(t, d);
    if (spend) { c.amt.n = spend.n; c.amt.mean = spend.mean; c.amt.m2 = spend.sd ** 2 * (spend.n - 1); }
    if (last) c.last = { ...last }; return c;
  }
  card(id) { let c = this.cards.get(id); if (!c) { c = { id, home: null, tier: "standard", opened: null, tx: new Series(D), amt: new Welford(), devices: new Distinct(90 * D), last: null }; this.cards.set(id, c); const p = this.profiles?.(id); if (p) this.registerCard(p); } return c; }
  dev(id) { let d = this.devices.get(id); if (!d) { d = { cards: new Distinct(D) }; this.devices.set(id, d); } return d; }
  ip(id) { let d = this.ips.get(id); if (!d) { d = { cards: new Distinct(H), small: new Series(600) }; this.ips.set(id, d); } return d; }

  /** Feature context for a transaction, computed from state *before* it is recorded. */
  context(tx) {
    const t = tx.t, c = this.card(tx.card), dv = this.dev(tx.device || "unknown"), ip = this.ip(tx.ip || "unknown"), la = Math.log1p(tx.amount);
    if (!c.home) c.home = tx.country; if (c.opened == null) c.opened = t;
    let travelKm = 0, kmh = 0; if (c.last && tx.lat != null && c.last.lat != null) { travelKm = km(c.last, tx); const dt = Math.max(60, t - c.last.t) / H; kmh = travelKm > 50 ? travelKm / dt : 0; }
    const w10 = c.tx.window(t, 600), w1h = c.tx.window(t, H), w24 = c.tx.window(t, D);
    return {
      id: tx.id, t, amount: tx.amount, currency: tx.currency || "INR", mcc: tx.mcc, merchant: tx.merchant, country: tx.country, city: tx.city, channel: tx.channel || "cnp",
      hour: tx.hour ?? new Date(t * 1000).getUTCHours(),
      card: { id: c.id, home: c.home, tier: c.tier, age_days: (t - c.opened) / D, count_10m: w10.count, count_1h: w1h.count, count_24h: w24.count, sum_24h: Math.round(w24.sum), avg_amount: c.amt.n ? Math.round(Math.expm1(c.amt.mean)) : 0, z: +c.amt.z(la).toFixed(2), devices_90d: c.devices.count(t) },
      device: { id: tx.device, new: !!tx.device && !c.devices.has(tx.device) && c.amt.n > 0, cards_24h: dv.cards.count(t) + (dv.cards.has(tx.card) ? 0 : 1) },
      ip: { id: tx.ip, cards_1h: ip.cards.count(t) + (ip.cards.has(tx.card) ? 0 : 1), small_10m: ip.small.window(t, 600).count },
      travel: { km: Math.round(travelKm), kmh: Math.round(kmh), from: c.last?.city || null },
    };
  }
  record(tx, ctx) {
    const c = this.card(tx.card), t = tx.t;
    c.tx.add(t, tx.amount); if (tx.device) { c.devices.add(t, tx.device); this.dev(tx.device).cards.add(t, tx.card); }
    if (tx.ip) { const ip = this.ip(tx.ip); ip.cards.add(t, tx.card); if (tx.amount < 100) ip.small.add(t, 1); }
    if (ctx.decision !== "decline") c.amt.add(Math.log1p(tx.amount)); // do not let blocked fraud shift the profile
    if (tx.lat != null && ctx.decision !== "decline") c.last = { t, lat: tx.lat, lon: tx.lon, city: tx.city };
  }
  score(tx, { explain = false } = {}) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const ctx = this.context(tx), x = vectorize(ctx), p = this.model.prob(x);
    let s = Math.round(p * 1000); ctx.model = { score: s, p };
    const hits = this.rules.run(ctx, explain), fired = hits.filter((h) => !h.miss);
    for (const h of fired) if (h.action === "score") s = Math.max(0, Math.min(1000, s + h.delta));
    let decision = s >= this.th.decline ? "decline" : s >= this.th.review ? "review" : "approve", by = "model";
    const forced = fired.filter((h) => h.action !== "score").sort((a, b) => RANK[b.action] - RANK[a.action])[0];
    if (forced && (forced.action !== "approve" || decision !== "decline")) { decision = forced.action; by = "rule:" + forced.name; }
    ctx.decision = decision;
    const reasons = [...fired.filter((h) => h.action !== "approve").map((h) => ({ kind: "rule", name: h.name, action: h.action, delta: h.delta })), ...(ctx.model.score >= 150 ? this.model.explain(x) : []).map((c) => ({ kind: "model", name: c.key, why: c.why, contrib: +c.contrib.toFixed(2) }))];
    const res = { id: tx.id, decision, score: s, modelScore: ctx.model.score, by, reasons, ctx, x, us: t0 ? Math.round((performance.now() - t0) * 1000) : 0 };
    if (explain) res.trace = hits;
    this.record(tx, ctx); this.stats.scored++; this.stats[decision]++; this.stats.amount += tx.amount; if (decision === "decline") this.stats.blocked += tx.amount;
    this.hist.set(tx.id, { x, score: s, decision, amount: tx.amount, label: null, t: tx.t, tx });
    if (this.hist.size > this.maxHistory) this.hist.delete(this.hist.keys().next().value);
    if (decision === "review") this.cases.set(tx.id, { id: tx.id, t: tx.t, tx, score: s, reasons, status: "open" });
    this.emit({ type: "decision", tx, res }); return res;
  }
  /** Ground truth (chargeback, confirmed-good or analyst verdict). Updates outcome metrics and, if enabled, the model. */
  label(id, fraud, { source = "chargeback" } = {}) {
    const h = this.hist.get(id); if (!h || h.label != null) return false; h.label = fraud ? 1 : 0; this.stats.labels++;
    const flagged = h.decision !== "approve", o = this.outcomes;
    if (h.decision === "decline") fraud ? o.dtp++ : o.dfp++;
    if (fraud) { flagged ? o.tp++ : o.fn++; if (h.decision === "decline") o.savedAmt += h.amount; else if (h.decision === "approve") o.lostAmt += h.amount; }
    else { flagged ? o.fp++ : o.tn++; if (h.decision === "decline") o.frictionAmt += h.amount; }
    if (this.learn) this.model.update(h.x, h.label);
    const cs = this.cases.get(id); if (cs && cs.status === "open") { cs.status = fraud ? "fraud" : "legit"; cs.source = source; }
    this.emit({ type: "label", id, fraud, source, decision: h.decision }); return true;
  }
  resolve(id, fraud) { return this.label(id, fraud, { source: "analyst" }); }
  openCases() { return [...this.cases.values()].filter((c) => c.status === "open"); }
  metrics() {
    const S = [], L = []; for (const h of this.hist.values()) if (h.label != null) { S.push(h.score); L.push(h.label); }
    const o = this.outcomes, flagged = o.tp + o.fp;
    return { scored: this.stats.scored, labelled: S.length, auc: S.length ? auc(S, L) : NaN, precision: flagged ? o.tp / flagged : NaN, recall: o.tp + o.fn ? o.tp / (o.tp + o.fn) : NaN, ...o, declineRate: this.stats.decline / (this.stats.scored || 1), reviewRate: this.stats.review / (this.stats.scored || 1), at: (th) => confusion(S.map((s) => s >= th), L) };
  }
  static fields() { return new Set(["amount", "currency", "mcc", "merchant", "country", "city", "channel", "hour", "model.score", ...["id", "home", "tier", "age_days", "count_10m", "count_1h", "count_24h", "sum_24h", "avg_amount", "z", "devices_90d"].map((k) => "card." + k), "device.id", "device.new", "device.cards_24h", "ip.id", "ip.cards_1h", "ip.small_10m", "travel.km", "travel.kmh", "travel.from"]); }
}
export { FEATURES };
