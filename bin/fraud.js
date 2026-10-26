#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FraudEngine, Traffic, KINDS, Logistic, RuleSet, DEFAULT_RULES, FEATURES, CITIES, MERCHANTS } from "../src/index.js";
import { c, table, header, fail, bar, num } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes("--" + n);
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("fraud")} — Prism Fraud: real-time transaction risk scoring with rules, sliding-window features and an online model

  fraud demo                                   scripted scenarios with explanations
  fraud score [tx.json | --amount --city ...]  score one transaction and explain every rule
  fraud simulate [--minutes 10 --rate 30]      live synthetic traffic with attacks, outcome report
  fraud train [--hours 24 --save]              train the model from scratch, evaluate on a holdout
  fraud rules [file.fraud]                     parse + lint a rule file
  fraud bench [--n 100000]                     scoring throughput and latency percentiles
  fraud serve [--port 8787]                    HTTP API (POST /v1/score, /v1/label, GET /v1/cases, /v1/metrics)
`;
const inr = (v) => "₹" + num(v, v < 100 ? 2 : 0);
const col = (d) => (d === "decline" ? c.red : d === "review" ? c.yellow : c.green)(d.toUpperCase().padEnd(7));
const why = (r) => r.reasons.map((x) => (x.kind === "rule" ? c.magenta(`[${x.name}${x.action === "score" ? ` ${x.delta > 0 ? "+" : ""}${x.delta}` : ""}]`) : c.dim(x.why))).join(c.dim(" · ")) || c.dim("nothing unusual");
const line = (tx, r) => `  ${col(r.decision)} ${String(r.score).padStart(4)}  ${inr(tx.amount).padStart(10)}  ${tx.mcc.padEnd(11)} ${(tx.city || "").padEnd(10)} ${why(r)}`;
function world(seed = 3) { const tr = new Traffic({ seed }), e = new FraudEngine({ learn: false, profiles: (id) => tr.profile(id) });  return { tr, e }; }
const pct = (q, a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

try {
  if (!cmd || cmd === "help" || cmd === "--help") console.log(HELP);
  else if (cmd === "demo") {
    const { tr, e } = world(); for (let i = 0; i < 60; i++) { const { txs, labels } = tr.step(10); tr.queue = []; for (const x of txs) if (!x._fraud) e.score(x); for (const l of labels) e.label(l.id, l.fraud); }
    e.learn = true; for (const k of Object.keys(e.outcomes)) e.outcomes[k] = 0; const fpWarm = e.stats.review + e.stats.decline;
    console.log(header("fraud demo", `${num(e.stats.scored)} warm-up transactions build card, device and IP history (${((fpWarm / e.stats.scored) * 100).toFixed(2)}% of genuine traffic flagged)`) + "\n");
    const sec = (t) => console.log("\n" + c.bold(t));
    const cust = tr.customers.find((k) => k.tier === "standard" && !k.fam && e.cards.get(k.card)?.amt.n >= 2) || tr.customers[0], at = () => tr.t;
    const mk = (o) => ({ id: "d" + ++tr.seq, t: (tr.t += o.dt ?? 5), card: cust.card, amount: o.amount, mcc: o.mcc, merchant: "m-" + o.mcc, city: o.city || cust.home, country: CITIES[o.city || cust.home].country, lat: CITIES[o.city || cust.home].lat, lon: CITIES[o.city || cust.home].lon, device: o.device === undefined ? cust.devices[0] : o.device, ip: o.ip || cust.ip, channel: o.channel || "cnp", hour: o.hour ?? 14 });
    const run = (o) => { const tx = mk(o), r = e.score(tx); console.log(line(tx, r)); return r; };
    sec(`1. ${cust.card} (${cust.home}) buys groceries and dinner as usual`);
    run({ amount: Math.round(Math.exp(cust.mu)), mcc: "grocery", channel: "pos", dt: 600 }); run({ amount: Math.round(Math.exp(cust.mu) * 0.6), mcc: "restaurant", dt: 900 });
    sec("2. Card testing: one device + IP tries tiny donations on many stolen cards");
    const ring = tr.customers.slice(200, 211); let last;
    for (const v of ring) { const g = CITIES[v.home], tx = { ...mk({ amount: 1 + (v.card.charCodeAt(9) % 40), mcc: "donation", device: "dev-ring", ip: "ip-ring" }), card: v.card, city: v.home, country: g.country, lat: g.lat, lon: g.lon }; tx.t = tr.t += 3; last = e.score(tx); if (ring.indexOf(v) % 3 === 0 || ring.indexOf(v) === ring.length - 1) console.log(line(tx, last)); }
    sec("3. Account takeover: the same card, a new device, Lagos, ₹89,000 of electronics");
    const ato = run({ amount: 89000, mcc: "electronics", city: "Lagos", device: "dev-lagos", ip: "ip-lagos", dt: 1800 });
    sec("4. Cloned card at a POS in London 20 minutes after a purchase in " + cust.home);
    run({ amount: 1200, mcc: "restaurant", channel: "pos", dt: 7200 }); run({ amount: 42000, mcc: "fashion", city: "London", channel: "pos", device: null, ip: "ip-pos-london", dt: 1200 });
    sec("5. A genuine customer on holiday: landed in Dubai after a 5 h flight, own phone");
    run({ amount: 3500, mcc: "restaurant", city: "Dubai", ip: "ip-roam", dt: 5 * 3600 });
    sec("6. Explain the ATO decision rule by rule");
    const ex = e.score({ ...mk({ amount: 89000, mcc: "electronics", city: "Lagos", device: "dev-lagos2", ip: "ip-lagos", dt: 3600 }) }, { explain: true });
    for (const h of ex.trace) { console.log(`  ${h.miss ? c.dim("○") : c.magenta("●")} ${h.miss ? c.dim(h.name) : h.name}`); for (const t of h.trace) console.log(`      ${t.ok ? c.green("✓") : c.red("✗")} ${t.src} ${c.dim("← " + JSON.stringify(t.got))}`); }
    console.log(`  ${c.bold("model")} ${ex.modelScore} ${c.dim("· top contributions:")} ${ex.reasons.filter((r) => r.kind === "model").map((r) => `${r.name} +${r.contrib}`).join(", ")}`);
    sec("7. Chargebacks and analyst verdicts arrive: the model updates online");
    const w0 = [...e.model.w], demo = [...e.hist.values()].filter((h) => h.tx.id.startsWith("d"));
    for (const h of demo) e.label(h.tx.id, h.tx.device === "dev-ring" || /lagos|london/.test(h.tx.ip || ""), { source: "analyst" });
    const moved = FEATURES.map((f, i) => [f.key, e.model.w[i] - w0[i]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    console.log(`  ${demo.length} labels applied · largest weight moves: ${moved.map(([k, d]) => `${k} ${d >= 0 ? "+" : ""}${d.toFixed(3)}`).join(", ")}`);
    const m = e.metrics(); console.log(`  outcomes so far: ${m.tp} fraud stopped, ${m.fp} false positives, ${m.fn} missed · saved ${inr(m.savedAmt)}`);
    sec("8. Ship a new rule without a deploy");
    const r2 = e.setRules(DEFAULT_RULES + `rule "lagos-electronics" decline when city == "Lagos" and mcc == "electronics"\n`); console.log(`  ${r2.rules.length} rules · version ${r2.version} · lint: ${r2.lint(FraudEngine.fields()).map((w) => w.msg).join("; ") || c.green("clean")}`);
    run({ amount: 15000, mcc: "electronics", city: "Lagos", device: "dev-lagos", ip: "ip-lagos", dt: 120 });
  } else if (cmd === "score") {
    const { tr, e } = world(5); for (let i = 0; i < 30; i++) { const { txs } = tr.step(10); tr.queue = []; for (const x of txs) if (!x._fraud) e.score(x); }
    let tx; if (pos[0]) tx = JSON.parse(readFileSync(pos[0], "utf8")); else { const city = flag("city", "Mumbai"), g = CITIES[city]; if (!g) fail("unknown city " + city + " (" + Object.keys(CITIES).join(", ") + ")"); tx = { id: "cli-1", card: flag("card", tr.customers[1].card), amount: +flag("amount", 2500), mcc: flag("mcc", "grocery"), merchant: "m-cli", city, country: g.country, lat: g.lat, lon: g.lon, device: flag("device", tr.customers[1].devices[0]), ip: flag("ip", tr.customers[1].ip), channel: flag("channel", "cnp") }; }
    tx.t ??= tr.t + 60; const r = e.score(tx, { explain: true });
    console.log(header("score", `${tx.id} · ${tx.card} · ${inr(tx.amount)} ${tx.mcc} in ${tx.city}`) + "\n");
    console.log(`  ${col(r.decision)} score ${c.bold(r.score)} ${c.dim(`(model ${r.modelScore}, decided by ${r.by}, ${r.us} µs)`)}\n`);
    const f = r.ctx; console.log(table([["card", `count 10m ${f.card.count_10m} · 1h ${f.card.count_1h} · avg ${inr(f.card.avg_amount)} · z ${f.card.z} · home ${f.card.home} · ${f.card.tier}`], ["device", `${f.device.new ? c.yellow("new for this card") : "known"} · cards 24h ${f.device.cards_24h}`], ["ip", `cards 1h ${f.ip.cards_1h} · small 10m ${f.ip.small_10m}`], ["travel", `${f.travel.km} km from ${f.travel.from || "-"} · ${num(f.travel.kmh)} km/h`]], { head: ["feature", "value"] }));
    console.log(); for (const h of r.trace) { console.log(`  ${h.miss ? c.dim("○ " + h.name) : c.magenta("● " + h.name + " → " + h.action)}`); for (const t of h.trace) console.log(`      ${t.ok ? c.green("✓") : c.red("✗")} ${t.src} ${c.dim("← " + JSON.stringify(t.got))}`); }
    console.log("\n  " + c.bold("model contributions") + "\n" + r.x.map((v, i) => [FEATURES[i].key, v, e.model.w[i] * v]).sort((a, b) => b[2] - a[2]).slice(0, 6).map(([k, v, z]) => `  ${k.padEnd(16)} ${bar(Math.max(0, z) / 6, 18, z > 0 ? c.red : c.green)} ${z >= 0 ? "+" : ""}${z.toFixed(2)}`).join("\n"));
  } else if (cmd === "simulate") {
    const mins = +flag("minutes", 10), tr = new Traffic({ seed: +flag("seed", 9), rate: +flag("rate", 30), fraud: 3 }), e = new FraudEngine({ profiles: (id) => tr.profile(id) }); 
    const by = {}; e.on((ev) => { if (ev.type !== "decision") return; const k = ev.tx._kind; by[k] ||= { n: 0, approve: 0, review: 0, decline: 0, amt: 0, stopped: 0 }; const b = by[k]; b.n++; b[ev.res.decision]++; b.amt += ev.tx.amount; if (ev.res.decision !== "approve") b.stopped += ev.tx.amount; });
    const lat = [], T = performance.now(); for (let s = 0; s < mins * 60; s += 1) { const { txs, labels } = tr.step(1); for (const x of txs) lat.push(e.score(x).us); for (const l of labels) e.label(l.id, l.fraud); }
    const m = e.metrics(); console.log(header("simulate", `${mins} min · ${num(e.stats.scored)} transactions · ${(performance.now() - T).toFixed(0)} ms wall`) + "\n");
    console.log(table(Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([k, b]) => [k === "legit" ? c.green("legitimate") : c.red(KINDS[k]), num(b.n), num(b.approve), num(b.review), num(b.decline), k === "legit" ? c.dim(((b.review + b.decline) / b.n * 100).toFixed(2) + "% friction") : bar(b.stopped / b.amt, 14, c.green) + " " + ((b.stopped / b.amt) * 100).toFixed(0) + "% of ₹ stopped"]), { head: ["traffic", "tx", "approve", "review", "decline", "outcome"], align: ["l", "r", "r", "r", "r", "l"] }));
    console.log(`\n  labelled ${num(m.labelled)} · AUC ${m.auc.toFixed(4)} · precision ${(m.precision * 100).toFixed(1)}% · recall ${(m.recall * 100).toFixed(1)}% · saved ${inr(m.savedAmt)} · missed ${inr(m.lostAmt)}`);
    console.log(`  latency p50 ${pct(0.5, lat)} µs · p99 ${pct(0.99, lat)} µs\n\n  ${c.bold("rule hits")}  ${Object.entries(e.rules.hits).map(([k, v]) => `${k} ${c.accent(v)}`).join(c.dim(" · "))}`);
  } else if (cmd === "train") {
    const hours = +flag("hours", 24), tr = new Traffic({ seed: 1, customers: 30000, rate: 6 }), e = new FraudEngine({ model: new Logistic({ bias: -5 }), profiles: (id) => tr.profile(id) }); 
    const run = (secs) => { tr.fraud = 4; for (let s = 0; s < secs; s += 10) { const { txs, labels } = tr.step(10); for (const x of txs) e.score(x); for (const l of labels) e.label(l.id, l.fraud); } };
    const T = performance.now(); run(hours * 3600); const trainN = e.stats.scored;
    e.learn = false; e.hist.clear(); for (const k of Object.keys(e.outcomes)) e.outcomes[k] = 0; run(Math.max(1, hours / 4) * 3600);
    const m = e.metrics(); console.log(header("train", `${num(trainN)} train + ${num(e.stats.scored - trainN)} holdout transactions · ${((performance.now() - T) / 1000).toFixed(1)} s`) + "\n");
    console.log(`  holdout ROC AUC ${c.bold(m.auc.toFixed(4))}\n`); console.log(table([300, 450, 600, 800].map((th) => { const x = m.at(th); return [th, (x.precision * 100).toFixed(1) + "%", (x.recall * 100).toFixed(1) + "%", num(x.fp), num(x.fn)]; }), { head: ["threshold", "precision", "recall", "false +", "missed"], align: ["r", "r", "r", "r", "r"] }));
    console.log("\n  " + c.bold("weights") + "\n" + FEATURES.map((f, i) => `  ${f.key.padEnd(16)} ${bar(Math.abs(e.model.w[i]) / 6, 18, e.model.w[i] > 0 ? c.red : c.green)} ${e.model.w[i].toFixed(3)}`).join("\n") + `\n  ${"bias".padEnd(16)} ${e.model.b.toFixed(3)}`);
    if (has("save")) { const j = e.model.toJSON(), f = fileURLToPath(new URL("../src/weights.js", import.meta.url)); writeFileSync(f, `// Produced by \`fraud train --hours ${hours} --save\`. Holdout ROC AUC ${m.auc.toFixed(4)}.\nexport const WEIGHTS = {\n  weights: ${JSON.stringify(j.weights)},\n  bias: ${j.bias},\n};\n`); console.log(c.green("\n  ✓ saved " + f)); }
    if (!(m.auc > 0.9)) process.exit(1);
  } else if (cmd === "rules") {
    const src = pos[0] ? readFileSync(pos[0], "utf8") : DEFAULT_RULES, rs = new RuleSet(src), w = rs.lint(FraudEngine.fields());
    console.log(header("rules", `${rs.rules.length} rules · version ${rs.version}`) + "\n"); console.log(table(rs.rules.map((r) => [r.line, r.name, r.action === "score" ? `score ${r.delta > 0 ? "+" : ""}${r.delta}` : r.action, c.dim(r.src.replace(/^rule\s+"[^"]+"\s+\S+(\s+[+-]\d+)?\s+when\s+/, ""))]), { head: ["line", "rule", "action", "condition"] }));
    console.log(w.length ? "\n" + w.map((x) => c.yellow(`  ⚠ line ${x.line} ${x.rule}: ${x.msg}`)).join("\n") : c.green("\n  ✓ no warnings")); if (has("strict") && w.length) process.exit(1);
  } else if (cmd === "bench") {
    const n = +flag("n", 100000), tr = new Traffic({ seed: 4, rate: 200, fraud: 3 }), e = new FraudEngine({ learn: false, profiles: (id) => tr.profile(id) }); 
    const txs = []; while (txs.length < n) txs.push(...tr.step(1).txs);
    const lat = new Float64Array(n), T = performance.now(); for (let i = 0; i < n; i++) { const a = performance.now(); e.score(txs[i]); lat[i] = (performance.now() - a) * 1000; } const ms = performance.now() - T; const s = [...lat].sort((a, b) => a - b);
    console.log(header("bench", `${num(n)} transactions · ${e.rules.rules.length} rules · ${FEATURES.length} model features · 150k cards`) + "\n");
    console.log(table([["throughput", num(n / (ms / 1000)) + " tx/s"], ["latency p50", s[Math.floor(n * 0.5)].toFixed(1) + " µs"], ["latency p99", s[Math.floor(n * 0.99)].toFixed(1) + " µs"], ["latency p99.9", s[Math.floor(n * 0.999)].toFixed(1) + " µs"], ["decline / review", `${(e.stats.decline / n * 100).toFixed(2)}% / ${(e.stats.review / n * 100).toFixed(2)}%`]], { head: ["metric", "value"] }));
  } else if (cmd === "serve") {
    const { createServer } = await import("../src/node/server.js"), port = +flag("port", 8787), e = new FraudEngine();
    createServer(e).listen(port, () => { console.log(header("fraud", `HTTP API on http://localhost:${port}`) + "\n"); console.log(c.dim(`  curl -s localhost:${port}/v1/score?explain -d @examples/tx.json\n  curl -s localhost:${port}/v1/metrics\n  curl -s -X PUT localhost:${port}/v1/rules --data-binary @examples/rules.fraud`)); });
  } else fail(`unknown command ${cmd}\n\n${HELP}`);
} catch (e) { fail(e.stack || e.message); }
