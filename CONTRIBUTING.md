# Contributing

AI Factory is a Node.js project (ES modules, Node 22.13 or newer) with no third-party dependencies
(`package.json` lists none). It is developed and tested on Windows; other systems are not part of the regular test run.

## Setup

```bash
git clone https://github.com/chnclsr/ai_factory.git
cd ai_factory
npm run setup      # npm ci, environment check, tests, deploys the Antigravity plugin
npm run check      # environment and configuration check only
```

`npm run setup -- --skip-plugin` leaves your Antigravity plugin directory alone.

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (`node --test`), engines are replaced by fake CLIs |
| `npm run eval` | Memory eval harness, deterministic layer, about 15 s. `node --test` also fails on a regression against `src/memory/eval/baseline.json` |
| `npm run bench` | Memory read and write path benchmark |
| `npm run build:extension` | Regenerate `browser-extension/models.js` from `router_config.json` |
| `npm run deploy` | Install the plugin, hooks and rules into the Antigravity plugin directory |

Live checks that call real engines are opt-in: `AI_FACTORY_LIVE=1 npm run eval -- --live`.

## Layout

| Path | Contents |
|---|---|
| `router.mjs`, `quota_tracker.mjs`, `deploy_skill.mjs` | Command line entry points |
| `src/` | The router (`router.mjs`), watchdog, quota tracker |
| `src/memory/` | The memory layer and its tests; `src/memory/eval/` is the eval harness |
| `lib/` | Paths and plugin installation helpers |
| `plugins/ai-factory/` | The Antigravity plugin: hooks, rules, skill |
| `browser-extension/` | The actor/critic picker for the Antigravity web UI |
| `scripts/` | Setup, environment check, eval, benchmarks, reports |
| `docs/` | Architecture, memory design and diagrams |
| `.runtime/` | Local state; never committed |

Tests sit next to the code they cover (`*.test.mjs`).

## Conventions

- **Language.** Code, comments, documentation and commit messages are in English. The router's
  keyword lists contain Turkish on purpose, because users write requests in Turkish.
- **Commits.** One focused change per commit, with a message that says what changed and why
  (`feat(memory): ...`, `fix(router): ...`, `docs: ...`). Run `npm test` first.
- **Memory.** Anything that changes what an engine receives needs a scenario in
  `src/memory/eval/scenarios.mjs` or a unit test. Refresh the baseline with
  `npm run eval -- --save-baseline` only when a change is meant to move the numbers.
- **Configuration.** A new setting gets a default in `router_config.json` (or the module's
  defaults), a line in the README settings table, and a way to switch it off.
- **Safety.** Recorded conversation text is data, never instructions: anything that reaches an
  engine prompt from storage goes through `neutralizeForInjection`, and secrets are masked before
  anything is written.
