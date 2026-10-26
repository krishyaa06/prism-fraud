import { test } from "node:test";
import assert from "node:assert/strict";
import { FraudEngine, RuleSet, parseRules, tokenize, evaluate, RuleError, Logistic, auc, confusion, Series, Distinct, Welford, km, Traffic, CITIES, DEFAULT_RULES } from "../src/index.js";
import { createServer } from "../src/node/server.js";

const at = (city) => ({ city, country: CITIES[city].country, lat: CITIES[city].lat, lon: CITIES[city].lon });
let n = 0; const tx = (o) => ({ id: "t" + ++n, t: 1e6, card: "card-A", amount: 800, mcc: "grocery", merchant: "m1", device: "dev-A", ip: "ip-A", channel: "pos", hour: 13, ...at("Pune"), ...o });

test("sliding windows: exact counts, sums and expiry", () => {
  const s = new Series(3600); for (let t = 0; t < 100; t++) s.add(t * 60, t);
  assert.deepEqual(s.window(99 * 60, 600), { count: 10, sum: 90 + 91 + 92 + 93 + 94 + 95 + 96 + 97 + 98 + 99 });
  assert.equal(s.window(99 * 60, 3600).count, 60, "events older than the span are pruned");
  const d = new Distinct(100); d.add(0, "a"); d.add(50, "b"); d.add(60, "a"); assert.equal(d.count(120), 2); assert.equal(d.count(155), 1); assert.equal(d.has("b"), false);
  const w = new Welford(); for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) w.add(x); assert.equal(w.mean, 5); assert.ok(Math.abs(w.sd - 2.138) < 1e-3); assert.ok(w.z(9) > 1.8);
  assert.ok(Math.abs(km(CITIES.Mumbai, CITIES.Delhi) - 1150) < 20);
});
test("rule language: precedence, lists, suffixes, errors with position", () => {
  const [r] = parseRules(`rule "x" decline when a > 1 and b < 2 or c in ["p", "q"] and not d`);
  assert.equal(evaluate(r.cond, { a: 2, b: 1, c: "z", d: true }), true); assert.equal(evaluate(r.cond, { a: 0, b: 1, c: "q", d: false }), true); assert.equal(evaluate(r.cond, { a: 0, c: "q", d: true }), false);
  const [k] = parseRules(`rule "k" score -50 when amount >= 1.5k and amount < 2m`); assert.equal(k.delta, -50); assert.equal(evaluate(k.cond, { amount: 1500 }), true);
  assert.equal(evaluate(parseRules(`rule "m" review when (a + b) * 2 > 9`)[0].cond, { a: 2, b: 3 }), true);
  assert.throws(() => parseRules(`rule "a" decline when x >\nrule "b" review when y`), (e) => e instanceof RuleError && e.line === 2);
  assert.throws(() => parseRules(`rule "a" block when x`), /expected decline, review, approve or score/);
  assert.throws(() => parseRules(`rule "a" review when x\nrule "a" review when y`), /duplicate/);
  assert.throws(() => tokenize(`rule "a" review when x @ 1`), /unexpected "@"/);
  const w = new RuleSet(`rule "v" approve when card.tier == "vip"\nrule "t" review when card.cuont_1h > 3`).lint(FraudEngine.fields());
  assert.deepEqual(w.map((x) => x.msg), ["approve rule without an amount cap", 'unknown field "card.cuont_1h"']);
});
test("explain traces every comparison and boolean field with the value seen", () => {
  const rs = new RuleSet(`rule "ato" score +100 when device.new and amount > 5000`), [h] = rs.run({ device: { new: true }, amount: 9000 }, true);
  assert.deepEqual(h.trace.map((t) => [t.src, t.got, t.ok]), [["device.new", true, true], ["amount > 5000", 9000, true]]);
});
test("card testing: many cards on one device/IP with tiny amounts gets declined", () => {
  const e = new FraudEngine(); let last;
  for (let i = 0; i < 8; i++) { e.registerCard({ id: "v" + i, devices: ["own" + i], spend: { n: 20, mean: 7, sd: 0.8 } }); last = e.score(tx({ card: "v" + i, t: 1e6 + i * 4, amount: 5 + i, mcc: "donation", device: "dev-ring", ip: "ip-ring", channel: "cnp" })); }
  assert.equal(last.decision, "decline"); assert.match(last.by, /card-testing/); assert.equal(last.ctx.ip.cards_1h, 8); assert.equal(last.ctx.device.cards_24h, 8);
});
test("impossible travel, new-device ATO, and genuine travel after a flight", () => {
  const e = new FraudEngine(); e.registerCard({ id: "card-A", home: "IN", devices: ["dev-A"], spend: { n: 30, mean: Math.log(800), sd: 0.6 }, last: { t: 1e6 - 3600, ...at("Pune") } });
  assert.equal(e.score(tx({})).decision, "approve");
  const cl = e.score(tx({ t: 1e6 + 900, ...at("London"), amount: 42000, mcc: "fashion", device: null, ip: "pos-lon" }));
  assert.equal(cl.decision, "decline"); assert.ok(cl.ctx.travel.kmh > 900); assert.match(cl.by, /impossible-travel/);
  const ato = e.score(tx({ t: 1e6 + 2 * 86400, ...at("Lagos"), amount: 90000, mcc: "electronics", device: "dev-X", ip: "ip-X", channel: "cnp" }));
  assert.notEqual(ato.decision, "approve"); assert.ok(ato.ctx.device.new); assert.ok(ato.reasons.some((r) => r.name === "ato-new-device"));
  const trip = e.score(tx({ t: 1e6 + 6 * 86400, ...at("Dubai"), amount: 1500, mcc: "restaurant", ip: "roam" }));
  assert.equal(trip.decision, "approve", "own device, normal amount, plausible speed");
});
test("decision precedence: decline rule beats approve rule; approve rule overrides a model review", () => {
  const e = new FraudEngine({ rules: `rule "vip" approve when amount < 1m\nrule "block-lagos" decline when city == "Lagos"` });
  assert.equal(e.score(tx({ ...at("Lagos") })).decision, "decline");
  const e2 = new FraudEngine({ rules: `rule "vip" approve when amount < 1m`, review: 0 }); const r = e2.score(tx({})); assert.equal(r.decision, "approve"); assert.equal(r.by, "rule:vip");
  const e3 = new FraudEngine({ rules: `rule "s" score +600 when mcc == "crypto"` }); const s = e3.score(tx({ mcc: "crypto" })); assert.ok(s.score >= 600); assert.notEqual(s.decision, "approve");
});
test("labels: outcome accounting, review cases, and online learning", () => {
  const e = new FraudEngine({ rules: `rule "r" review when amount > 50000` }), r = e.score(tx({ amount: 60000 }));
  assert.equal(r.decision, "review"); assert.equal(e.openCases().length, 1);
  const w0 = [...e.model.w]; assert.equal(e.resolve(r.id, true), true); assert.equal(e.label(r.id, true), false, "labels are applied once");
  assert.equal(e.openCases().length, 0); assert.equal(e.cases.get(r.id).status, "fraud"); assert.equal(e.outcomes.tp, 1); assert.notDeepEqual(e.model.w, w0);
  const ok = e.score(tx({ amount: 500, t: 1e6 + 99 })); e.label(ok.id, true); assert.equal(e.outcomes.fn, 1); assert.equal(e.outcomes.lostAmt, 500);
});
test("logistic regression learns a separable problem; AUC + confusion are correct", () => {
  const m = new Logistic({ weights: [0, 0], bias: 0, posWeight: 1 }), X = [], Y = []; let s = 1; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) { const y = r() < 0.3 ? 1 : 0; X.push([y + r() * 0.6, r()]); Y.push(y); }
  m.fit(X, Y, 5, r); assert.ok(m.w[0] > 2 && Math.abs(m.w[1]) < m.w[0] / 2); assert.ok(auc(X.map((x) => m.prob(x)), Y) > 0.99);
  assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75); assert.equal(auc([1, 1], [0, 1]), 0.5);
  assert.deepEqual(confusion([1, 1, 0, 0], [1, 0, 1, 0]).tp, 1);
});
test("synthetic traffic is deterministic per seed and carries ground truth", () => {
  const a = new Traffic({ seed: 5, customers: 2000, rate: 10 }), b = new Traffic({ seed: 5, customers: 2000, rate: 10 }); a.attack("card-testing"); b.attack("card-testing");
  const x = a.step(60), y = b.step(60); assert.deepEqual(x.txs.map((t) => [t.id, t.amount]), y.txs.map((t) => [t.id, t.amount]));
  assert.ok(x.txs.some((t) => t._fraud && t._kind === "card-testing")); assert.throws(() => a.attack("nope"));
});
test("end to end: trained model separates fraud from genuine traffic", () => {
  const tr = new Traffic({ seed: 21, customers: 30000, rate: 6, fraud: 4 }), e = new FraudEngine({ learn: false, profiles: (id) => tr.profile(id) });
  for (let s = 0; s < 3 * 3600; s += 10) { const { txs, labels } = tr.step(10); for (const x of txs) e.score(x); for (const l of labels) e.label(l.id, l.fraud); }
  const m = e.metrics(); assert.ok(m.auc > 0.97, "auc " + m.auc); assert.ok(m.precision > 0.7, "precision " + m.precision); assert.ok(m.recall > 0.8, "recall " + m.recall);
});
test("HTTP API: score, explain, label, cases, metrics, hot rule reload", async () => {
  const e = new FraudEngine({ rules: DEFAULT_RULES + `rule "big" review when amount > 100000\n` }), srv = createServer(e, { clock: () => 1e6 }); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`, post = (p, b, m = "POST") => fetch(base + p, { method: m, body: typeof b === "string" ? b : JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
  try {
    const a = await post("/v1/score?explain", tx({ id: "h1", amount: 200000 })); assert.equal(a.s, 200); assert.equal(a.j.decision, "review"); assert.ok(Array.isArray(a.j.trace));
    assert.equal((await post("/v1/score", { id: "bad" })).s, 400);
    const cases = await fetch(base + "/v1/cases").then((r) => r.json()); assert.equal(cases[0].id, "h1");
    assert.equal((await post("/v1/cases/h1", { fraud: true })).s, 200); assert.equal((await post("/v1/label", { id: "nope", fraud: true })).s, 404);
    const met = await fetch(base + "/v1/metrics").then((r) => r.json()); assert.equal(met.tp, 1);
    const up = await post("/v1/rules", `rule "only" decline when amount > 10`, "PUT"); assert.equal(up.j.rules, 1);
    assert.equal((await post("/v1/score", tx({ id: "h2", amount: 50 }))).j.decision, "decline");
    assert.equal((await post("/v1/rules", `rule "x" decline when`, "PUT")).s, 400);
  } finally { srv.close(); }
});
