// Exact sliding-window aggregates per entity (card, device, ip, merchant).
// Events live in an append-only array with a moving head, so pruning is O(1) amortised and
// short windows scan backwards only over events that are inside them.
export class Series {
  constructor(span = 86400) { this.span = span; this.t = []; this.v = []; this.head = 0; this.sum = 0; }
  prune(now) { const lim = now - this.span; while (this.head < this.t.length && this.t[this.head] <= lim) { this.sum -= this.v[this.head]; this.head++; } if (this.head > 256 && this.head * 2 > this.t.length) { this.t = this.t.slice(this.head); this.v = this.v.slice(this.head); this.head = 0; } }
  add(now, v = 1) { this.prune(now); this.t.push(now); this.v.push(v); this.sum += v; }
  /** count + sum of events with t in (now - sec, now] */
  window(now, sec, pred) {
    this.prune(now); if (sec >= this.span && !pred) return { count: this.t.length - this.head, sum: this.sum };
    let c = 0, s = 0; for (let i = this.t.length - 1; i >= this.head && this.t[i] > now - sec; i--) { if (pred && !pred(this.v[i])) continue; c++; s += this.v[i]; } return { count: c, sum: s };
  }
  last() { return this.t.length > this.head ? this.t[this.t.length - 1] : null; }
}
/** Distinct values seen in the last `span` seconds (cards per device, devices per card, ...). */
export class Distinct {
  constructor(span = 86400) { this.span = span; this.m = new Map(); }
  add(now, key) { this.m.delete(key); this.m.set(key, now); this.prune(now); } // Map keeps insertion order = recency order
  prune(now) { for (const [k, t] of this.m) { if (t > now - this.span) break; this.m.delete(k); } }
  count(now, sec = this.span) { this.prune(now); let n = 0; for (const t of this.m.values()) if (t > now - sec) n++; return n; }
  has(key) { return this.m.has(key); }
}
/** Welford running mean / variance, used for per-card amount z-scores. */
export class Welford {
  constructor() { this.n = 0; this.mean = 0; this.m2 = 0; }
  add(x) { this.n++; const d = x - this.mean; this.mean += d / this.n; this.m2 += d * (x - this.mean); }
  get sd() { return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0; }
  z(x, floor = 0.35) { return this.n >= 3 ? (x - this.mean) / Math.max(floor, this.sd) : 0; }
}
export const km = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r, x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); };
