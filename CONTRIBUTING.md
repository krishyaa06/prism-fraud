# Contributing to prism-fraud

Thanks for taking the time to contribute! prism-fraud is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism Fraud decides approve, review or decline for every card authorisation in microseconds. It keeps exact sliding windows per card, device and IP (counts, sums, distinct cards), a running spend profile per card, and the last known location for impossible-travel checks. Analysts write rules in a small language (`rule "card-testing" decline when ip.cards_1h >= 4 and amount < 100`) that is parsed by a Pratt parser, linted against known fields and hot-reloaded without a deploy. A 14-feature logistic model, trained on synthetic traffic with ground truth and updated online from chargebacks and analyst verdicts, adds a calibrated score with per-feature explanations. A synthetic traffic generator with four fraud patterns (card testing, account takeover, cloned cards, bust-out) measures precision, recall and money saved.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-fraud.git
cd prism-fraud
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-fraud/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
