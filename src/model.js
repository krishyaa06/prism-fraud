// Feature vector + online logistic regression (AdaGrad SGD with L2), with per-feature explanations.
export const FEATURES = [
  { key: "log_amount", why: "large amount", f: (c) => Math.log1p(c.amount) / 10 },
  { key: "amount_z", why: "amount far above this card's normal", f: (c) => Math.max(-3, Math.min(6, c.card.z)) / 3 },
  { key: "card_count_10m", why: "many transactions on this card in 10 min", f: (c) => Math.min(10, c.card.count_10m) / 5 },
  { key: "card_count_1h", why: "high card velocity (1h)", f: (c) => Math.min(30, c.card.count_1h) / 10 },
  { key: "device_new", why: "first time this card is used on this device", f: (c) => +c.device.new },
  { key: "device_cards", why: "device used with several cards", f: (c) => Math.min(10, c.device.cards_24h - 1) / 3 },
  { key: "ip_cards", why: "IP used with several cards", f: (c) => Math.min(20, c.ip.cards_1h - 1) / 4 },
  { key: "small_burst", why: "burst of tiny authorisations (card testing)", f: (c) => Math.min(20, c.ip.small_10m) / 5 },
  { key: "foreign", why: "outside the card's home country", f: (c) => +(c.country !== c.card.home) },
  { key: "travel", why: "fast travel since the last transaction", f: (c) => Math.min(5, c.travel.kmh / 1000) },
  { key: "night", why: "unusual hour", f: (c) => +(c.hour < 5) },
  { key: "mcc_risk", why: "high-risk merchant category", f: (c) => MCC_RISK[c.mcc] ?? 0.2 },
  { key: "cnp", why: "card not present", f: (c) => +(c.channel === "cnp") },
  { key: "card_new", why: "very new card", f: (c) => +(c.card.age_days < 14) },
];
export const MCC_RISK = { grocery: 0, fuel: 0.1, restaurant: 0.05, travel: 0.4, electronics: 0.7, fashion: 0.3, giftcard: 1, crypto: 1, donation: 0.8, gaming: 0.6, utilities: 0 };
export const vectorize = (ctx) => FEATURES.map((d) => d.f(ctx));
const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export class Logistic {
  constructor({ weights, bias = -5, lr = 0.08, l2 = 1e-4, posWeight = 6 } = {}) { this.w = weights ? [...weights] : FEATURES.map(() => 0); this.b = bias; this.lr = lr; this.l2 = l2; this.pw = posWeight; this.g = this.w.map(() => 1e-6); this.gb = 1e-6; this.updates = 0; }
  prob(x) { let z = this.b; for (let i = 0; i < x.length; i++) z += this.w[i] * x[i]; return sig(z); }
  /** One AdaGrad step on a labelled example; positives are up-weighted because fraud is rare. */
  update(x, y) {
    const p = this.prob(x), err = (p - y) * (y ? this.pw : 1);
    for (let i = 0; i < x.length; i++) { const gi = err * x[i] + this.l2 * this.w[i]; this.g[i] += gi * gi; this.w[i] -= (this.lr * gi) / Math.sqrt(this.g[i]); }
    this.gb += err * err; this.b -= (this.lr * err) / Math.sqrt(this.gb); this.updates++; return p;
  }
  fit(X, Y, epochs = 4, r = Math.random) { const idx = X.map((_, i) => i); for (let e = 0; e < epochs; e++) { for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } for (const i of idx) this.update(X[i], Y[i]); } return this; }
  /** Contribution of each feature to the log-odds, largest first. */
  explain(x, n = 3) { return FEATURES.map((d, i) => ({ key: d.key, why: d.why, value: x[i], contrib: this.w[i] * x[i] })).filter((c) => c.contrib > 0.25).sort((a, b) => b.contrib - a.contrib).slice(0, n); }
  toJSON() { return { features: FEATURES.map((f) => f.key), weights: this.w.map((v) => +v.toFixed(4)), bias: +this.b.toFixed(4) }; }
}
/** ROC AUC by the rank-sum (Mann-Whitney U) method, ties averaged. */
export function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]); let pos = 0, neg = 0, rs = 0;
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (labels[idx[k]]) { rs += r; pos++; } else neg++; i = j; }
  return pos && neg ? (rs - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}
export function confusion(pred, labels) { const m = { tp: 0, fp: 0, tn: 0, fn: 0 }; pred.forEach((p, i) => { m[(p ? (labels[i] ? "tp" : "fp") : labels[i] ? "fn" : "tn")]++; }); m.precision = m.tp / (m.tp + m.fp || 1); m.recall = m.tp / (m.tp + m.fn || 1); m.f1 = (2 * m.precision * m.recall) / (m.precision + m.recall || 1); return m; }
