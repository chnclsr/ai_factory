# AI Factory architecture

[System diagram HTML](diagrams/ai-factory-architecture.html) · [Routing flow HTML](diagrams/ai-factory-routing.html)

The diagrams show the routing core. They do not yet draw the memory store or the Vibe engine as separate boxes (their labels were
corrected, the layout was not regenerated); this document is the complete description.

## Overview

```
Antigravity ──hooks──▶ router (src/router.mjs) ──▶ engine CLI (vibe | muse | claude)
   ▲  SessionStart            │  ▲                         │
   │  PreInvocation           │  └── memory block ◀── memory store (.runtime/memory.git)
   └─ Stop (records turns) ───┴─────────── records each turn ──┘
```

- The **plugin** (`plugins/ai-factory/`) gives Antigravity its routing rules and runs the hooks.
- The **router** (`src/router.mjs`, started through `router.mjs`) picks an engine and model, applies model and health checks, runs the
  engine CLI under a watchdog, and prints an execution report. `router_config.json` is its policy: engines, models, fallback chain,
  watchdog, circuit breaker, routing keywords and the `memory` section.
- The **memory layer** (`src/memory/`) records every call and gives each engine call the part of that history it has not seen.
- Runtime files (the memory store, search index, caches, health and quota state) live under `.runtime/`, or under
  `AI_FACTORY_DATA_DIR` when that variable is set.

## Routing policy

| Starting engine | Selection | Failure path (unless `--no-fallback`) |
|---|---|---|
| Vibe | Default: chain step 1 (`vibe-glm-5.3-flash`) and step 2 (`vibe-glm-5.3`); also a Vibe model name or the keywords `vibe`, `mistral vibe`. Complexity keywords pick the configured `complex_model` | Remaining chain steps → Gemini handoff |
| Muse | Chain step 3; a Muse model name or the keywords `muse`, `spark`, `meta`, `contributor`. Fixed contributor model | Remaining chain steps → Gemini handoff |
| Claude | Only when named: `--engine claude`, a Claude model name, or the keyword `claude`. Haiku by default, Opus 5.5 only when explicitly requested | Gemini handoff |

An explicit `--engine` or `--model` wins; then a model name found in the task text; then Gemini and engine keywords; otherwise
`fallback_chain` from `router_config.json`. The default chain is Vibe Flash → Vibe GLM 5.3 → Muse. Claude model aliases resolve
through `router_config.json`, then pass an allowlist and cost check before execution. The router invokes the engine CLIs with JSON output where
they offer it, captures the response text and session ID, and records a named session only when the provider returns an ID. Vibe health is
tracked per model, so one rate-limited model does not quarantine the other.

The per-engine health gate checks cached quota and circuit-breaker state before launching an engine. A failed response is classified; only
eligible failures follow the engine-specific fallback order. Gemini is a handoff to the parent Antigravity agent, not another API call by
the router.

## Engine execution

- Each engine receives its task through a file (`--prompt-file`, `--file`) or stdin, so command-line length limits never apply.
- A watchdog starts with the engine: status notices at 30, 120 and 240 seconds then every 120 seconds, a process-tree check after 30
  seconds without initial output or 120 seconds of silence, a stop when CPU stays unchanged for another 120 seconds, and a 10-minute hard limit.
  The limits are in `router_config.json`.
- `src/stream-capture.mjs` turns each engine's stdout and stderr into whole lines with one UTF-8 decoder per stream, so a chunk boundary
  never splits a line or a character. The router keeps the engine's whole stdout (a 512 KB head plus a rolling tail) for the memory, and
  the last 100 lines for error classification.
- Every engine prompt starts with one `[AI Factory] Language: …` line (`response_language`, default English): think and answer in that
  language unless the request explicitly asks for another.

## Report contract

Every completed router invocation prints an `[AI FACTORY EXECUTION REPORT]` with `path`, `choices`, `errors` and `succeed_with`. With memory
enabled, a Gemini handoff or an all-engines failure adds `handoff: <id>`, and the report ends with a `memory:` line (project, session, what the
block gave the engine or why nothing was injected, and the saved turn number). `path` starts with `gemini` as the caller label and includes
only engines attempted **inside that invocation**; it cannot reconstruct earlier independent calls. `[OK]` on a Gemini handoff means
delegation occurred; the parent agent must still complete and verify the task. Callers should quote the report rather than infer success from
a model's prose.

## Antigravity integration

`plugins/ai-factory/hooks.json` registers one handler, `hooks/hook_handler.js`, for these events:

| Event | What the hook does |
|---|---|
| `SessionStart` | Injects the routing rule (with the router command filled in, including `--session <conversationId>`), open handoffs for the project, and a short memory index of recent work with the commands that read more |
| `PreInvocation` | Injects the rule and open handoffs (a 50 ms deadline; on timeout or error the rule goes out alone) |
| `PreToolUse` | Denies removing a folder without approval, direct headless `claude -p` launches and repository reads that should go through the router |
| `Stop` | When a turn ends normally, starts a detached `memory record-agy` that records the user's request and the agent's final answer (see below) |

The router is used only when the message starts with `[AI Factory]` or the user asks for it or an engine by name; memory commands
(`memory search`, `memory session show`, `memory turn show`) only read and are always allowed. The browser extension in `browser-extension/` adds an
actor/critic picker above the Antigravity prompt box and prefixes `[AI Factory]` to the message when either role is on.

## Memory layer

`src/memory/` is the cross-call memory described in [memory-plan.md](memory-plan.md) (design and deviations) and
[memory-harness-plan.md](memory-harness-plan.md) (measurement and the follow-up work). It never imports the router or `lib/paths.mjs`; the router
passes the repository path and the `memory` config section in, and calls it at three points: `resolveSession` before the attempts loop,
`buildPrompt` for each attempt's task text, and `recordTurn` before the report. With `memory.enabled = false` the module is never loaded.

| File | Role |
|---|---|
| `gitobj.mjs` | Writes loose git objects in JS (no git process) and moves refs with git's `.lock` protocol plus a FIFO waiter queue |
| `store.mjs` | One commit per write on `refs/heads/p/<project>`, built under the ref lock; the `Seq:` trailer is the project's total order. Page versioning |
| `project.mjs`, `projects.mjs` | Project key from `--project`, `.ai-factory.toml`, the `upstream`/`origin` remote or the folder name; `memory project list/rename/merge` and `followMoves` |
| `sanitize.mjs` | Masks credentials and bounds sizes for every persisted string; neutralises instruction-like text before injection |
| `worktree.mjs` | Before/after snapshots of the user's project via a temporary `GIT_INDEX_FILE`; the diff between them is the turn's own change |
| `session.mjs` | Turn log (`sessions/<sid>.jsonl`), session meta, per-project aliases |
| `migrate.mjs` | One-time move of `session_registry.json` into per-project sessions, then renames it `.migrated` |
| `fts.mjs`, `search.mjs`, `vector.mjs` | Derived SQLite index (FTS5 over turns and pages; optional local vectors with an IVF index) and scoped search (`repo`, `dir`, `mine`, `--global`) |
| `pack.mjs` | Builds the `<retrieved-memory untrusted="true">` block: delta since the engine session's last known Seq, handoffs and errors, related notes and other sessions' turns, the conversation (own budget, newest turn last, long replies shortened in the middle) and the session state; per-model token budgets and a content-addressed cache |
| `state.mjs` | Background session state: a typed note (goal, decisions, constraints, latest answers, dead ends, open questions, files, next step) written by a cheap engine through a detached helper; every item cites its turns |
| `handoff.mjs` | `handoffs/<hid>.md` state machine (`open → accepted`); exactly one taker wins |
| `agy.mjs` | Records Antigravity's own turns from its transcript (`memory record-agy`, started by the `Stop` hook); turns that ran the router are skipped |
| `hook.mjs` | Read-only lookups the plugin hook imports: open handoffs and the memory index for a new conversation |
| `index.mjs` | The facade the router calls; every method catches its own errors and logs `[AI Factory Memory] …` |
| `cli.mjs` | `node router.mjs memory …`: session, turn, state, note, search, handoff, project and record-agy commands |
| `testing/` | Test infrastructure: the fake engine CLIs harness, fixtures, the canary retrieval set. Not used by the product |
| `eval/` | The memory eval harness: scenarios, the runner, the live layer and the stored baseline |

With memory enabled, `--name`/`--resume` read and write memory sessions instead of `session_registry.json`. A resume that names a different
engine than the session last used starts a new conversation in that engine; the router's "session has no ID to resume" check still applies
when the same engine is resumed without a saved ID.

Memory errors never fail a task: a broken store, a slow snapshot or a missing git binary produces one log line and the call continues. File
tracking costs git processes on the write path only (two per snapshot, two for the diff). Helper calls of the router itself (the session-state
summariser) run with `--no-memory` at depth 1, so they neither read nor record memory.

The interactive HTML diagrams are self-contained. Their editable sources are the adjacent JSON files, validated with Archify's showcase
profile. Diagram text, guided views and viewer controls are in English.
