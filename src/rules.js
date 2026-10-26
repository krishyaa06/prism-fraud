// A small rule language for fraud analysts:
//   rule "card-testing" decline when ip.cards_1h >= 4 and amount < 50
//   rule "vip"          approve when card.tier == "vip" and amount < 20000
//   rule "night-crypto" score +150 when mcc in ["crypto", "giftcard"] and hour < 5
// Tokenizer + Pratt parser -> AST, evaluated against the feature context with a trace of every comparison.
export class RuleError extends Error { constructor(msg, line, col) { super(line ? `${msg} (line ${line}:${col})` : msg); this.line = line; this.col = col; } }
const KW = new Set(["rule", "when", "and", "or", "not", "in", "true", "false", "decline", "review", "approve", "score"]);
export function tokenize(src) {
  const out = []; let i = 0, line = 1, col = 1;
  const push = (t, v, l, c) => out.push({ t, v, line: l, col: c });
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") { i++; line++; col = 1; continue; }
    if (/\s/.test(ch)) { i++; col++; continue; }
    if (ch === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    const l = line, c = col;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1]))) { let j = i; while (j < src.length && /[0-9._]/.test(src[j])) j++; let v = src.slice(i, j).replace(/_/g, ""); let mult = 1; if (/[kKmM]/.test(src[j] || "") && !/[A-Za-z0-9_]/.test(src[j + 1] || "")) { mult = /[kK]/.test(src[j]) ? 1e3 : 1e6; j++; } if (isNaN(+v)) throw new RuleError(`bad number "${v}"`, l, c); push("num", +v * mult, l, c); col += j - i; i = j; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1, s = ""; while (j < src.length && src[j] !== ch) { if (src[j] === "\n") throw new RuleError("unterminated string", l, c); s += src[j++]; } if (j >= src.length) throw new RuleError("unterminated string", l, c); push("str", s, l, c); col += j + 1 - i; i = j + 1; continue; }
    if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++; const w = src.slice(i, j); push(KW.has(w) ? w : "id", w, l, c); col += j - i; i = j; continue; }
    const two = src.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) { push("op", two, l, c); i += 2; col += 2; continue; }
    if ("<>+-*/(),[]".includes(ch)) { push("op", ch, l, c); i++; col++; continue; }
    throw new RuleError(`unexpected "${ch}"`, l, c);
  }
  push("eof", null, line, col); return out;
}
const BP = { or: 1, and: 2, "==": 4, "!=": 4, "<": 4, ">": 4, "<=": 4, ">=": 4, in: 4, "+": 5, "-": 5, "*": 6, "/": 6 };
export function parse(src) {
  const T = tokenize(src); let p = 0;
  const peek = () => T[p], next = () => T[p++], err = (msg, t = peek()) => { throw new RuleError(msg, t.line, t.col); };
  const expect = (t, v) => { const k = next(); if (k.t !== t || (v != null && k.v !== v)) err(`expected ${v ?? t}, got ${k.v ?? k.t}`, k); return k; };
  const key = (t) => (t.t === "op" ? t.v : t.t === "and" || t.t === "or" || t.t === "in" ? t.t : null);
  function prefix() {
    const t = next();
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "true" || t.t === "false") return { k: "lit", v: t.t === "true" };
    if (t.t === "id") return { k: "var", path: t.v, at: t };
    if (t.t === "not") return { k: "not", e: expr(3) };
    if (t.t === "op" && t.v === "-") return { k: "neg", e: expr(7) };
    if (t.t === "op" && t.v === "(") { const e = expr(0); expect("op", ")"); return e; }
    if (t.t === "op" && t.v === "[") { const items = []; if (!(peek().t === "op" && peek().v === "]")) do items.push(expr(0)); while (peek().t === "op" && peek().v === "," && next()); expect("op", "]"); return { k: "list", items }; }
    err(`unexpected ${t.v ?? t.t}`, t);
  }
  function expr(rbp) {
    let left = prefix();
    for (;;) { const t = peek(), op = key(t); if (!op || !(op in BP) || BP[op] <= rbp) break; next(); left = { k: "bin", op, l: left, r: expr(BP[op]), at: t }; }
    return left;
  }
  const rules = [], seen = new Set();
  while (peek().t !== "eof") {
    const r0 = expect("rule"), name = expect("str").v; if (seen.has(name)) err(`duplicate rule "${name}"`, r0); seen.add(name);
    const a = next(); let action, delta = 0;
    if (a.t === "decline" || a.t === "review" || a.t === "approve") action = a.t;
    else if (a.t === "score") { action = "score"; const sg = next(); if (sg.t !== "op" || (sg.v !== "+" && sg.v !== "-")) err("expected + or - after score", sg); delta = (sg.v === "-" ? -1 : 1) * expect("num").v; }
    else err(`expected decline, review, approve or score, got ${a.v ?? a.t}`, a);
    expect("when"); rules.push({ name, action, delta, cond: expr(0), line: r0.line, src: "" });
  }
  const lines = src.split("\n"); for (const r of rules) r.src = lines[r.line - 1].trim();
  return rules;
}
const get = (ctx, path) => { let v = ctx; for (const k of path.split(".")) { if (v == null) return undefined; v = v[k]; } return v; };
export function evaluate(n, ctx, trace) {
  switch (n.k) {
    case "lit": return n.v;
    case "var": return get(ctx, n.path);
    case "list": return n.items.map((x) => evaluate(x, ctx, trace));
    case "not": return !truthy(n.e, ctx, trace);
    case "neg": return -evaluate(n.e, ctx, trace);
    case "bin": {
      if (n.op === "and") return truthy(n.l, ctx, trace) && truthy(n.r, ctx, trace);
      if (n.op === "or") return truthy(n.l, ctx, trace) || truthy(n.r, ctx, trace);
      const a = evaluate(n.l, ctx, trace), b = evaluate(n.r, ctx, trace); let v;
      switch (n.op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return b ? a / b : 0;
        case "==": v = a === b; break; case "!=": v = a !== b; break; case "<": v = a < b; break; case ">": v = a > b; break; case "<=": v = a <= b; break; case ">=": v = a >= b; break; case "in": v = Array.isArray(b) && b.includes(a); break; }
      if (trace && n.l.k === "var") trace.push({ src: `${n.l.path} ${n.op} ${n.r.k === "list" ? "[…]" : n.r.k === "lit" ? JSON.stringify(n.r.v) : n.r.path || "expr"}`, got: a, ok: v });
      return v;
    }
  }
}
// bare fields used as booleans (`device.new`) are traced too
function truthy(n, ctx, trace) { const v = evaluate(n, ctx, trace); if (trace && n.k === "var") trace.push({ src: n.path, got: v, ok: !!v }); return v; }
export const vars = (n, out = new Set()) => { if (!n) return out; if (n.k === "var") out.add(n.path); for (const c of [n.l, n.r, n.e, ...(n.items || [])]) vars(c, out); return out; };
/** Compile a rule set. run(ctx) returns every matching rule with its trace. */
export class RuleSet {
  constructor(src) { this.src = src; this.rules = parse(src); this.version = "r" + this.rules.length + "-" + [...src].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36); this.hits = Object.fromEntries(this.rules.map((r) => [r.name, 0])); }
  run(ctx, explain = false) {
    const out = []; for (const r of this.rules) { const trace = explain ? [] : null; let ok = false; try { ok = !!evaluate(r.cond, ctx, trace); } catch { ok = false; } if (ok) { this.hits[r.name]++; out.push({ name: r.name, action: r.action, delta: r.delta, trace }); } else if (explain) out.push({ name: r.name, action: r.action, miss: true, trace }); }
    return out;
  }
  lint(known) {
    const w = []; for (const r of this.rules) { for (const v of vars(r.cond)) if (known && !known.has(v)) w.push({ rule: r.name, line: r.line, msg: `unknown field "${v}"` }); if (r.cond.k === "lit") w.push({ rule: r.name, line: r.line, msg: "condition is a constant" }); if (r.action === "approve" && !vars(r.cond).has("amount")) w.push({ rule: r.name, line: r.line, msg: "approve rule without an amount cap" }); }
    return w;
  }
}
export const DEFAULT_RULES = `# Prism Fraud rules. Actions: decline | review | approve | score +N / -N
# decline beats review beats approve; score rules adjust the model score (0-1000).
rule "card-testing"      decline when ip.cards_1h >= 4 and amount < 100
rule "impossible-travel" decline when travel.kmh > 900 and travel.km > 500
rule "device-farm"       review  when device.cards_24h >= 3
rule "burst"             review  when card.count_10m >= 5
rule "ato-new-device"    score +180 when device.new and country != card.home and amount > 5000
rule "risky-goods-night" score +120 when mcc in ["giftcard", "crypto"] and hour < 5
rule "trusted-regular"   approve when card.tier == "vip" and not device.new and amount < 20000
`;
