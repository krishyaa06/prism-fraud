// Synthetic card traffic with ground truth: everyday spending with daily seasonality, plus
// legitimate edge cases (travel, big purchases, shared family devices) and four fraud patterns.
import { rng } from "./lib/rng.js";
import { CITIES, HOME, MERCHANTS } from "./data.js";

const FOREIGN = ["Dubai", "Singapore", "London", "Lagos", "Moscow", "Bangkok", "NewYork"];
const istHour = (t) => Math.floor(((t + 19800) % 86400) / 3600);
const DAY = [0.12, 0.08, 0.06, 0.05, 0.06, 0.12, 0.3, 0.55, 0.8, 1, 1.05, 1.1, 1.15, 1.1, 1.05, 1, 1.05, 1.15, 1.3, 1.4, 1.35, 1.1, 0.7, 0.35];
export const KINDS = { "card-testing": "Card testing", ato: "Account takeover", skimming: "Cloned card", bustout: "Bust-out spike" };
export class Traffic {
  constructor({ seed = 7, customers = 150000, rate = 30, fraud = 1, t0 = Date.UTC(2026, 9, 26, 4, 30) / 1000, labelDelay = [20, 90] } = {}) {
    this.r = rng(seed); this.t = t0; this.t0 = t0; this.rate = rate; this.fraud = fraud; this.labelDelay = labelDelay; this.seq = 0; this.queue = []; this.labels = []; this.recent = []; this.counts = {};
    const r = this.r; this.customers = [];
    for (let i = 0; i < customers; i++) {
      const home = r() < 0.04 ? FOREIGN[r.int(0, 2)] : HOME[Math.floor(r() ** 1.4 * HOME.length)], fam = r() < 0.08 && i > 0 && !this.customers[i - 1].fam ? this.customers[i - 1] : null;
      const dev = fam ? fam.devices[0] : "dev-" + i.toString(36);
      this.customers.push({ id: "c" + i, card: "card-" + String(i).padStart(5, "0"), home, country: CITIES[home].country, tier: r() < 0.1 ? "vip" : "standard", opened: t0 - (r() < 0.04 ? r.int(1, 12) : r.int(30, 2500)) * 86400,
        fam: !!fam, devices: [dev, ...(r() < 0.3 ? ["dev-" + i.toString(36) + "b"] : [])], ip: fam ? fam.ip : "ip-" + (i % 9000).toString(36), mu: Math.log(300 + r() ** 2 * 4000), likes: [r.int(0, 6), r.int(0, 6), r.int(0, 7)] });
    }
  }
  get byCard() { return this._bc || (this._bc = new Map(this.customers.map((c) => [c.card, c]))); }
  /** Historical profile per card, as a feature store would provide it (devices, spend distribution, last location). */
  profiles() { return this.customers.map((c) => this.profileOf(c)); }
  profile(cardId) { const c = this.byCard.get(cardId); return c ? this.profileOf(c) : null; }
  profileOf(c) { { const g = CITIES[c.home]; return { id: c.card, home: c.country, tier: c.tier, opened: c.opened, devices: c.devices, spend: { n: 25, mean: c.mu + 0.1, sd: 0.85 }, last: { t: this.t0 - 3 * 3600 - (c.card.charCodeAt(9) % 7) * 3600, city: c.home, lat: g.lat, lon: g.lon } }; } }
  tx(c, o) { const city = o.city || c.home, g = CITIES[city]; const t = o.t ?? this.t; return { id: "tx" + ++this.seq, t, hour: istHour(t), card: c.card, amount: Math.round(o.amount * 100) / 100, currency: "INR", merchant: o.m.id, mcc: o.m.mcc, city, country: g.country, lat: g.lat, lon: g.lon, device: o.device === undefined ? this.r.pick(c.devices) : o.device, ip: o.ip ?? c.ip, channel: o.channel || (this.r() < 0.55 ? "cnp" : "pos"), _fraud: !!o.fraud, _kind: o.kind || "legit", _cust: c.id }; }
  legit() {
    const r = this.r; let c = r.pick(this.customers);
    const away = (k) => k.trip && (this.t < k.trip.land || (this.t > k.trip.back && this.t < k.trip.back + 5 * 3600));
    if (away(c)) c = r.pick(this.customers); // in the air: no card activity
    if (away(c)) c = r.pick(this.customers.filter((k) => !k.trip).slice(0, 100));
    if (c.trip && this.t >= c.trip.back + 5 * 3600) c.trip = null;
    const m = r() < 0.7 ? MERCHANTS[r.pick(c.likes)] : r.pick(MERCHANTS.slice(0, 8)), x = r();
    let amount = Math.exp(r.normal(c.mu, 0.55)) * m.avg, city = c.home, device, ip;
    if (c.trip && this.t >= c.trip.land) { city = c.trip.city; ip = "ip-roam-" + c.id; } // abroad with their own phone
    else if (x < 0.003 && !c.trip) c.trip = { city: r.pick(FOREIGN.filter((f) => f !== c.home)), land: this.t + 3600 * (4 + r() * 6), back: this.t + 86400 * (2 + r() * 5) }; // books a flight
    else if (x < 0.012) amount *= 6 + r() * 8; // big but genuine purchase
    else if (x < 0.016) { device = "dev-new-" + c.id + "-" + r.int(0, 3); } // new phone
    return this.tx(c, { m, amount: Math.max(10, amount), city, device, ip });
  }
  /** Inject a fraud scenario; its transactions are scheduled into the future. */
  attack(kind, at = this.t) {
    const r = this.r, M = (id) => MERCHANTS.find((m) => m.id === id), out = [], ring = "ring" + this.seq.toString(36); this.counts[kind] = (this.counts[kind] || 0) + 1;
    if (kind === "card-testing") {
      const victims = Array.from({ length: r.int(8, 14) }, () => r.pick(this.customers)), dev = "dev-" + ring, ip = "ip-" + ring; let t = at;
      for (const v of victims) { t += 1 + r() * 6; out.push(this.tx(v, { t, m: r() < 0.6 ? M("m-helpnow") : M("m-steam"), amount: 1 + r() * 48, device: dev, ip, channel: "cnp", fraud: true, kind })); }
      for (const v of victims.slice(0, 2)) { t += 4 + r() * 10; out.push(this.tx(v, { t, m: M("m-giftly"), amount: 15000 + r() * 35000, device: dev, ip, channel: "cnp", fraud: true, kind })); }
    } else if (kind === "ato") {
      const v = r.pick(this.customers), city = r() < 0.6 ? r.pick(FOREIGN.filter((f) => f !== v.home)) : r.pick(HOME.filter((h) => h !== v.home)), dev = "dev-" + ring, ip = "ip-" + ring; let t = at;
      for (let i = 0, n = r.int(1, 3); i < n; i++) { t += 20 + r() * 80; out.push(this.tx(v, { t, m: M(r.pick(["m-croma", "m-giftly", "m-coinx"])), amount: 20000 + r() * 130000, city, device: dev, ip, channel: "cnp", fraud: true, kind })); }
    } else if (kind === "skimming") {
      const pool = this.recent.length ? this.recent : this.customers.slice(0, 50).map((c) => ({ c, t: at })), { c: v } = r.pick(pool);
      const city = r.pick(FOREIGN.filter((f) => CITIES[f].country !== v.country)); let t = at;
      for (let i = 0, n = r.int(1, 2); i < n; i++) { t += 30 + r() * 200; out.push(this.tx(v, { t, m: M(r.pick(["m-croma", "m-myntra"])), amount: 8000 + r() * 52000, city, device: null, ip: "ip-pos-" + city, channel: "pos", fraud: true, kind })); }
    } else if (kind === "bustout") {
      const v = r.pick(this.customers); let t = at;
      for (let i = 0, n = r.int(3, 6); i < n; i++) { t += 10 + r() * 60; out.push(this.tx(v, { t, m: M(r.pick(["m-croma", "m-coinx", "m-irctc", "m-giftly"])), amount: Math.exp(v.mu) * (10 + r() * 25), device: v.devices[0], fraud: true, kind })); }
    } else throw new Error("unknown attack " + kind);
    this.queue.push(...out); this.queue.sort((a, b) => a.t - b.t); return out;
  }
  /** Advance the clock; returns transactions in time order and the labels that became known. */
  step(dt) {
    const r = this.r, t1 = this.t + dt, out = [], lam = this.rate * DAY[istHour(this.t)];
    let t = this.t; for (;;) { t += r.exp(lam); if (t > t1) break; this.t = t; const x = this.legit(); out.push(x); this.recent.push({ c: this.byCard.get(x.card), t }); if (this.recent.length > 60) this.recent.shift(); }
    const pf = this.fraud * dt; // about one scenario per second of sim time at fraud = 1 / 60
    for (const k of Object.keys(KINDS)) if (r() < pf * { "card-testing": 0.004, ato: 0.012, skimming: 0.008, bustout: 0.005 }[k]) this.attack(k, this.t);
    while (this.queue.length && this.queue[0].t <= t1) out.push(this.queue.shift());
    this.t = t1; out.sort((a, b) => a.t - b.t);
    for (const x of out) this.labels.push({ id: x.id, fraud: x._fraud, at: x.t + (x._fraud ? this.labelDelay[0] + r() * (this.labelDelay[1] - this.labelDelay[0]) : this.labelDelay[1]) });
    const due = []; this.labels.sort((a, b) => a.at - b.at); while (this.labels.length && this.labels[0].at <= t1) due.push(this.labels.shift());
    return { txs: out, labels: due };
  }
}
export { CITIES };
