import http from "node:http";
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e6) { bad(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(b)); });
const REQ = ["id", "card", "amount"];
/** HTTP API: POST /v1/score, POST /v1/label, GET|POST /v1/cases, GET /v1/metrics, GET|PUT /v1/rules, GET /healthz */
export function createServer(engine, { clock = () => Date.now() / 1000 } = {}) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    try {
      if (p === "/healthz") return json(res, 200, { ok: true, scored: engine.stats.scored });
      if (p === "/v1/score" && req.method === "POST") {
        const tx = JSON.parse(await read(req)); const miss = REQ.filter((k) => tx[k] == null); if (miss.length) return json(res, 400, { error: "missing " + miss.join(", ") });
        if (!(typeof tx.amount === "number" && tx.amount > 0)) return json(res, 400, { error: "amount must be a positive number" });
        tx.t ??= clock(); const r = engine.score(tx, { explain: u.searchParams.has("explain") });
        return json(res, 200, { id: r.id, decision: r.decision, score: r.score, modelScore: r.modelScore, by: r.by, reasons: r.reasons, features: r.ctx, latencyUs: r.us, ...(r.trace ? { trace: r.trace } : {}) });
      }
      if (p === "/v1/label" && req.method === "POST") { const { id, fraud } = JSON.parse(await read(req)); return json(res, engine.label(id, !!fraud) ? 200 : 404, { ok: true }); }
      if (p === "/v1/cases" && req.method === "GET") return json(res, 200, engine.openCases().slice(-100).map((c) => ({ id: c.id, score: c.score, amount: c.tx.amount, card: c.tx.card, reasons: c.reasons })));
      const m = /^\/v1\/cases\/([\w-]+)$/.exec(p); if (m && req.method === "POST") { const { fraud } = JSON.parse(await read(req)); return json(res, engine.resolve(m[1], !!fraud) ? 200 : 404, { ok: true }); }
      if (p === "/v1/metrics") { const x = engine.metrics(); delete x.at; return json(res, 200, { ...x, stats: engine.stats, rules: engine.rules.hits }); }
      if (p === "/v1/rules" && req.method === "GET") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(engine.rules.src); }
      if (p === "/v1/rules" && req.method === "PUT") { const r = engine.setRules(await read(req)); return json(res, 200, { version: r.version, rules: r.rules.length, warnings: r.lint(engine.constructor.fields()) }); }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
}
