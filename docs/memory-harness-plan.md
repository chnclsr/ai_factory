# Memory harness and follow-up continuity: development plan

Extends `docs/memory-plan.md` (the memory layer itself).

## Status (2026-11-16)

Shipped: H1-H5 (layer 1, live layer with judge, replay, threshold sweep), Phases 0, 1, 2 and 3,
and the rule-file fix (section 6). Phase 4 is deliberately not built: no scenario shows a need for
a link graph or summaries of summaries.

Phase 3 was built because the 40-turn budget-pressure scenario still failed at 1600 tokens (the
plan's condition). With a stored state the block for that case is 421 tokens instead of 1758 and
carries the buried codename; with the real background helper, vibe flash wrote a 4-item state in
one call and both vibe flash and muse answered correctly. Defaults: `state_min_turns` 12,
`state_every_turns` 8, so conversations that fit the budget never spend a call. Also changed
afterwards: the router's default vibe model is now `vibe-glm-5.3-flash` (the CLI no longer serves
`glm-5-3`).

| Measurement | Before | After |
|---|---|---|
| Layer 1, all 24 scenarios | 13/23 pass (pull scenario added later) | 22/24 pass |
| Layer 1, gated coverage | 0.632 | 1.0 |
| Layer 1, follow-up scenarios | 0/5 | 5/5 |
| Threshold sweep, gated coverage at `conversation_tokens` 0 / 400 / 800+ | | 0.65 / 0.95 / 1.0 |
| Live follow-ups, vibe flash and muse (judge: vibe flash, 1 run) | | vibe 5/5, muse 4/5 |
| Live, follow-ups + cross-engine + update + abstention + dead end + pull | | vibe 9/10, muse 7/10 before the rubric fix |
| Live block rejections | | 0 |

Still failing in layer 1: the inflected Turkish cross-session query (keyword search misses
`veritabanının yedeğini` for `Veritabanı yedekleri`; local vectors fix it but are off by default)
and the 40-turn budget-pressure case at 1600 tokens (passes at 2400). Both are non-gated.

Live notes: every answer tied the follow-up to the right earlier answer; none asked what it
referred to. The remaining live failures are engine behaviour, not memory: muse once claimed it had
run a migration script that does not exist in the seeded workspace, and on replayed real sessions
the cheap judge graded some "I can't re-verify here" answers as failures. Replays run in an empty
workspace, so engines cannot re-read the original files. The vibe CLI currently rejects the default
model `glm-5-3` ("Unknown model"); live runs used `vibe-glm-5.3-flash`.

Not done: billed-versus-sent token tracking (cache impact) and the external LongMemEval/LoCoMo
subset; the live layer runs once per scenario unless `--runs` is raised.

## 1. Why

A short follow-up such as "emin misin" (are you sure?) failed to resolve to the latest substantive
answer in a multi-engine conversation. Patching that one case is not enough: the same weakness
shows up as lost constraints, repeated dead ends and unhelpful clipping. We need a **harness** that
measures what memory is supposed to do across a whole conversation, and a set of changes that are
accepted only when the harness numbers improve.

## 2. What the code does today (verified by reading, not assumed)

| Finding | Where | Consequence |
|---|---|---|
| The recorded output is the **last 100 non-empty lines** of the engine's stdout and stderr | `src/router.mjs` (`tailBuffer`) | The beginning of a long plain-text reply (muse, codex) is never stored. "Fetch the full reply" has nothing to fetch. |
| `response_ref` is written only when the reply exceeds 2 KB | `src/memory/session.mjs` (`responseRef`) | Short replies live only in `response_head`. Readers must use `response_ref ?? response_head`. |
| The block uses `response_head` clipped to 400 (recent 3 turns) or 200 characters | `src/memory/pack.mjs` (L1) | A substantive answer falls out as soon as a few short turns follow it. |
| `fill()` skips a candidate that does not fit instead of shortening it | `src/memory/pack.mjs` | The most important turn can be dropped whole. |
| `clip()` collapses every line break | `src/memory/pack.mjs` | A verbatim answer containing code becomes unreadable. |
| Over budget, the body is cut from the end | `src/memory/pack.mjs` | Sections run oldest to newest, so the newest turn is what gets cut. |
| Settings other than finite numbers are dropped | `src/memory/index.mjs` (`packSettings`) | A boolean flag such as `anchor_full: true` silently does nothing. Use numeric settings (`0` = off). |
| The recursion guard (`depth >= 2`) runs before the `memory` subcommand | `src/router.mjs` | A nested router call running `memory turn show` prints a handoff report and exits 0. Move the `memory` branch above the guard. |
| Token estimate is characters / 4 | `src/memory/pack.mjs` (`estimateTokens`) | Turkish is closer to 2.5-3 characters per token, so a "3k" budget is really 4-5k. |
| The live matrix still runs `opencode` and `codex` | `scripts/live-memory-matrix.mjs` | Noise from engines that are outside the chain. |
| The block sits at the very front of the prompt and changes every turn | `src/memory/pack.mjs` (`buildPrompt`) | Likely defeats prompt caching on engines that cache prefixes. Unmeasured. |
| Already shipped | commits `a19d5fa`, `4d2b7ea` | Short tasks still get session history; section says the new request continues the conversation; older turns keep a 200-character reply; L1 gets at least 60% of the budget. |

## 3. Research that shaped the plan

- No repository should be adopted wholesale: claude-mem is bound to Claude Code hooks; Mem0, Graphiti,
  Cognee and Letta need Python or a service and an LLM call per write; ai-memory needs a server.
- The closest design is **LCM (lossless context management)**: raw messages stay in SQLite, old
  ones become summaries that act as pointers, the most recent messages stay verbatim, and tools
  (grep, describe, expand) fetch originals. "Lossless" means the originals are kept, not that
  summaries are. Summaries drift.
- **SoMem**: linked notes whose entries link back to the raw interaction as evidence.
- **NVIDIA, "You don't need long context"**: compacting to a short state note loses little accuracy
  (reported SWE-bench Verified and Terminal-Bench results, median peak context 7-9K tokens). What the
  note contains matters more than the fact of compaction: goal, constraints that tightened,
  relevant files, tried-and-failed paths, next step. A chronological summary can keep the wrong
  things. Models react differently, so the threshold must be measured per task. Compaction breaks
  the prompt cache, so fewer tokens is not always a cheaper bill. Long documents are better kept in
  a file and grepped than pasted.
- Free-form LLM-extracted graphs tend to collapse into generic labels; if a graph is built it must
  use a typed schema.
- Figures above are second-hand (papers summarised on X and LinkedIn); none were reproduced here.

## 4. The harness

Three layers, one scenario format.

### Layer 1: deterministic, no LLM (`node --test`, seconds)

Scripted multi-turn scenarios replayed through the real router with the fake engine CLIs
(`router-harness.mjs`). After each turn the exact prompt sent to the engine is captured and scored
against annotations: facts that must be present, facts that must be absent, token budget.

Metrics: context recall, noise tokens, budget overruns, latency p50 and p95, spawned processes.
This layer gates every commit.

### Layer 2: live engines (opt-in, `AI_FACTORY_LIVE=1`)

The same scenarios run against vibe, muse and claude. Answers are checked with a hidden suffix
(`<canary>-OK`, never written anywhere, so echoing the prompt cannot pass) plus string and regex
checks. A small judge model is used only for open-ended answers (decision pending, section 9).

Metrics: answer accuracy, block rejection rate (answers containing "injection", "untrusted",
"cannot follow"), tokens and cost per scenario, engine pair results. Billed tokens versus sent tokens
are recorded per engine so cache effects are visible. Each scenario runs 3 times, majority wins.

### Layer 3: replay of real sessions

Real conversations already in `.runtime/memory.git` are exported as fixtures with gold questions
added, then replayed against every new version of the pack builder. This catches what synthetic
scripts do not produce (for example the stray `ve582691` fragment in a stored reply).

### Scenario format

Each scenario declares: engines per turn, the turns (task, scripted reply), gold facts, forbidden
facts, the question asked at the end, the budget, and the checks. One JSON report per run goes to
`.runtime/memory-eval/`, per scenario, engine and version; a compare command shows regressions
against a stored baseline.

### Scenario categories

| Category | Question it answers |
|---|---|
| Follow-up resolution | Does "are you sure", "continue", "why" bind to the right earlier answer? |
| Single-session recall | Is a detail from turn 2 available at turn 12? |
| Cross-engine continuity | Engine A tells, engine B recalls (every ordered pair in the chain) |
| Cross-session recall | Another conversation in the same project, including inflected Turkish |
| Knowledge update | A newer decision overrides an older one: which reaches the block? |
| Abstention | A question about something never said gets no invented "memory" |
| Isolation | Another project's facts never appear |
| Instruction persistence | A standing rule from turn 1 still holds at turn 20 |
| Constraint retention | A requirement tightened at turn 4 is enforced at turn 15 |
| Dead-end avoidance | After engine A fails at X, engine B does not repeat X |
| Handoff | An open handoff is taken exactly once |
| File and diff recall | "What did we change in X?" answered from recorded diffs |
| Error recovery | A fallback step sees the previous attempt's error |
| Robustness | Long code blocks, 256 KB replies, UTF-8, CRLF, injection text inside stored turns |
| Budget pressure | 50-turn sessions on 800-token models: what survives |
| Pull behavior | When a turn is shortened, does the engine open the full text, and is the answer better |
| Cache impact | Does block layout change billed tokens on a repeated call |
| Scale | 10k events, p95 pack build time |

### Threshold sweep

For each engine, sweep the conversation budget and find where compaction starts to hurt, instead of
guessing 800, 2000 or 3000.

### Optional external reference

A small LongMemEval or LoCoMo subset adapted to the turn format, run on demand, for comparison with
published numbers. Costly, so never part of the default run.

## 5. Phases

Each phase is independently shippable and reversible with a numeric setting (`0` = old behavior).

| Phase | Goal | Size | Per-turn cost |
|---|---|---|---|
| H1 | Scenario runner and prompt capture (Layer 1 core) | Medium | 0 LLM |
| H2 | Scoring, report and compare command | Small | 0 LLM |
| H3 | First scenarios: follow-up, single-session recall, cross-engine, abstention | Medium | 0 LLM |
| 0 | Store the full reply; take the baseline | Small-medium | 0 LLM |
| 1 | Conversation budget: shorten, never drop | Medium | 0 LLM, +2-4k input tokens |
| 2 | Evidence pointers and `memory turn show` | Small | 0 LLM |
| H4 | Real-session export (Layer 3) and the live runner (Layer 2) | Medium | live engines |
| H5 | Remaining categories, threshold sweep, cache metric | Medium | live engines |
| 3 | Background typed session state | Large | 1 free-model call past a threshold |
| 4 | Typed link graph, summaries of summaries | Large | 0 LLM |

Order: H1, H2, H3, then Phase 0 (which also produces the baseline), Phase 1, Phase 2, H4, H5.
Phase 3 only if long conversations still fail after Phase 1. Phase 4 is deferred until there is a
measured need.

### Phase 0: store the full reply, take the baseline

- Keep a separate reply buffer (up to 256 KB) next to `tailBuffer` and record that as the output.
  JSON engines are already parsed by `extractResponseText`.
- Write `response_ref` for every turn, or read `response_ref ?? response_head` everywhere.
- Run the H3 scenarios against today's `pack.mjs` and the live matrix with
  `--only=vibe,muse,claude`. Store both numbers as the baseline. Expect low coverage: the canary
  sits beyond the first 400 characters.
- Remove `opencode` and `codex` from the live matrix and from the handoff targets in `cli.mjs`.

### Phase 1: conversation budget

- No "substantive turn" classifier, it would pick the wrong anchor. Walk from newest to oldest and
  give each turn at most half of the remaining conversation budget, with at least one line
  guaranteed.
- A reply that does not fit keeps its first 70% and last 30% with a marker such as
  `[... 800 characters skipped, turn 3]`.
- Section order: handoffs and errors, related items, older turns, newest turn last, and the final
  trim must never cut the newest turn.
- A formatter that keeps line breaks for verbatim replies; `clip()` stays for one-line items.
- New numeric settings: `conversation_tokens` (`0` = old behavior) and a per-model
  `memory_conversation_tokens`. Related items get their own `l2_tokens`.
- Budgets assume 2.5-3 characters per token for Turkish.
- Start free models at 2k; go to 3k only if the live rejection rate is no worse than baseline.

### Phase 2: pull path

- `memory turn show <n> --session <s> [--max-bytes]` reads `response_ref ?? response_head`, passes
  the text through `neutralizeForInjection`, and never depends on the FTS index (so it works while
  the index is locked).
- Move the `memory` branch above the recursion guard in `router.mjs`.
- The hint is written by the router **outside** the untrusted block, just before the
  `New request:` line, with absolute paths (`process.execPath`, router path, `--cwd`). It appears
  only when something in the block was shortened, and is switched per engine with `memory_pull`.

### Phase 3 (conditional): background session state

Only if the long-conversation slice (20+ turns) of the H3 set still fails after Phase 1.

- A detached child process (`detached`, `unref`, `windowsHide: true`, `stdio: 'ignore'`) after the
  router has recorded the turn, because the router exits with `process.exit`.
- Guards: explicit `AI_FACTORY_ROUTER_DEPTH=1`, start only at depth 0, a new `--no-memory` flag so
  the summariser's own call is not recorded, `--no-fallback`, a single free model, at most one call
  a minute and one per N turns, skip when the health registry shows rate limiting.
- The model call happens **outside** the ref lock; the write inside `commitProject` compares
  `through_turn` and gives up if a newer state exists.
- State-shaped, not a timeline: goal, constraints, relevant files, decisions, tried-and-failed
  attempts, open questions, next step. Every item carries `turns: [n]` and can be expanded with
  the Phase 2 command. Unparseable output is discarded and the rule-based view stays.
- The block uses the state only up to `through_turn`; later turns stay as raw lines.

## 6. Cheap fix outside the memory code

`plugins/ai-factory/rules/ai_factory_router.md` should tell Antigravity to write a self-contained
task ("check the previous answer about X") instead of passing a bare follow-up. One sentence, no
code. Add it with Phase 0 and measure its effect on the same scenario set.

## 7. Definition of done

- Deterministic coverage of the gold facts is at least 95% on the follow-up scenarios, and no
  category regresses against the stored baseline.
- In the live matrix every engine pair in the chain passes the follow-up canary.
- Rejection rate on free models is no worse than baseline.
- `node --test` is green and `benchPack` reports zero budget overruns.
- Every new behavior is switched off by one numeric setting.

## 8. Risks

- **Free models reject a larger block as injection.** Earlier live runs showed mimo and longcat
  doing this. Mitigation: per-model budgets, rejection rate as a gate, never put commands inside the
  untrusted block.
- **Summaries drift** (Phase 3). Mitigation: every item links to the raw turn, and Phase 3 stays
  conditional.
- **LLM-graded answers are noisy.** Mitigation: three runs and majority, deterministic layer as the
  hard gate.
- **Concurrent sessions on one ref.** The current lock is sequential and lossless and the turn
  number is computed inside it; the only new risk is a summariser writing from an old snapshot,
  handled by the `through_turn` check.
- **`sessions/<sid>.jsonl` is rewritten on every turn**, so cost grows with session length. Not a
  problem now; watch it when Phase 3 triggers.
- **Windows and `node:sqlite`.** New read paths use git objects (`snapshot.read`), not the FTS index.

## 9. Open decisions

1. Judge: may a small Claude model grade open-ended live answers (small cost per run), or are
   string and regex checks enough?
2. Scenario source: written by us in Turkish and English, or seeded from a few real conversations
   supplied by the owner (Layer 3 first)?
