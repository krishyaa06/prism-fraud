# Prism Fraud — Usage

## Install

```bash
npm install github:krishyaa06/prism-fraud
# or run the CLI directly
npx github:krishyaa06/prism-fraud --help
```

## JavaScript API

```js
import { FraudEngine } from "prism-fraud";

const fraud = new FraudEngine({
  rules: `rule "card-testing" decline when ip.cards_1h >= 4 and amount < 100
          rule "impossible-travel" decline when travel.kmh > 900 and travel.km > 500
          rule "ato" score +180 when device.new and country != card.home and amount > 5k`,
  review: 450, decline: 800,
  profiles: (cardId) => featureStore.get(cardId),   // optional history: devices, spend, last location
});

const r = fraud.score({
  id: "tx-91", t: Date.now() / 1000, card: "card-00042", amount: 64999, mcc: "electronics",
  city: "Lagos", country: "NG", lat: 6.52, lon: 3.38, device: "dev-9", ip: "203.0.113.7", channel: "cnp",
}, { explain: true });

r.decision;   // "decline"
r.score;      // 0..1000
r.by;         // "rule:impossible-travel"
r.reasons;    // [{ kind: "rule", name: "ato", delta: 180 }, { kind: "model", why: "first time this card is used on this device" }]
r.trace;      // every rule, every comparison, every value seen

fraud.label("tx-91", true);          // chargeback -> outcome metrics + online model update
fraud.openCases();                   // review queue
fraud.setRules(src);                 // hot reload
fraud.metrics();                     // { auc, precision, recall, savedAmt, lostAmt, ... }
```

| Export | What it does |
|---|---|
| `new FraudEngine({ rules, model, review, decline, learn, profiles, maxHistory })` | The decision engine |
| `.score(tx, { explain })` | `{ decision, score, modelScore, by, reasons, ctx, x, us, trace? }` |
| `.label(id, fraud, { source })` · `.resolve(id, fraud)` | Ground truth and analyst verdicts (each applied once) |
| `.openCases()` · `.cases` · `.metrics()` · `.stats` · `.outcomes` · `.on(fn)` | Review queue, AUC / precision / recall / money saved, events `decision` and `label` |
| `.setRules(src)` · `.registerCard(profile)` · `FraudEngine.fields()` | Hot reload, seed history, known rule fields |
| `new RuleSet(src)` · `.run(ctx, explain)` · `.lint(fields)` · `parseRules` · `tokenize` · `evaluate` · `RuleError` | Rule language |
| `new Logistic({ weights, bias, lr, l2, posWeight })` · `.prob` · `.update` · `.fit` · `.explain` · `FEATURES` · `auc` · `confusion` | Model |
| `Series` · `Distinct` · `Welford` · `km` | Window and statistics primitives |
| `new Traffic({ seed, customers, rate, fraud })` · `.step(dt)` · `.attack(kind)` · `.profile(card)` · `KINDS` | Synthetic traffic with ground truth |
| `createServer(engine)` from `src/node/server.js` | HTTP API |

## CLI

```bash
$ npx github:krishyaa06/prism-fraud demo
$ npx github:krishyaa06/prism-fraud score examples/tx.json
$ npx github:krishyaa06/prism-fraud simulate --minutes 10
$ npx github:krishyaa06/prism-fraud train --hours 24
$ npx github:krishyaa06/prism-fraud rules examples/rules.fraud
$ npx github:krishyaa06/prism-fraud bench
$ npx github:krishyaa06/prism-fraud serve --port 8787
```

| Command | Description |
|---|---|
| `fraud demo` | Normal spending, card testing, ATO, cloned card, genuine travel, a full rule trace, online learning, hot reload |
| `fraud score [tx.json \| --amount --mcc --city --device --ip --card]` | Score one transaction against warmed-up history and explain it |
| `fraud simulate [--minutes 10 --rate 30 --seed 9]` | Live traffic with attacks; per-pattern outcomes, AUC, precision, recall, latency |
| `fraud train [--hours 24] [--save]` | Train from scratch on synthetic history, evaluate on a holdout, optionally write `src/weights.js` |
| `fraud rules [file.fraud] [--strict]` | Parse and lint a rule file |
| `fraud bench [--n 100000]` | Throughput and latency percentiles |
| `fraud serve [--port 8787]` | HTTP API |

## Live simulator

Open [https://krishyaa06.github.io/prism-fraud/](https://krishyaa06.github.io/prism-fraud/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
