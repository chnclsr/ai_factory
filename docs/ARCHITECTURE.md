# AI Factory architecture

[System diagram HTML](diagrams/ai-factory-architecture.html) · [Routing flow HTML](diagrams/ai-factory-routing.html)

The plugin's `PreInvocation` / `PreToolUse` hooks live in `plugins/ai-factory/hooks/`. They inject routing guidance and can steer repository analysis toward the local `router.mjs` CLI. The router itself lives in `src/router.mjs`; `router_config.json` is its engine/model and watchdog policy. Runtime files, including the named-session registry, stay under `.runtime/` unless `AI_FACTORY_DATA_DIR` is set.

## Routing policy

| Starting engine | Selection | Failure path (unless `--no-fallback`) |
|---|---|---|
| OpenCode | Default (chain steps 1–3: DeepSeek v4.1, MiMo v2.6, GLM 5.3), named OpenCode model, or OpenCode keywords; only free allowlisted models | Remaining chain steps → Gemini handoff |
| Muse | Chain step 4, Muse model name or keywords; fixed contributor model | Remaining chain steps → Gemini handoff |
| Codex | Chain step 5 (`gpt-6-luna`), named Codex model or keywords; free tier only (luna, terra) | Remaining chain steps → Gemini handoff |
| Claude | Explicit or Claude keywords; Haiku by default, Opus 5.5 when explicitly requested | Gemini handoff |

An explicit `--engine` or `--model` wins; then a model name found in the task text; then Gemini and engine keywords; otherwise `fallback_chain` from `router_config.json`. OpenCode health is tracked per model, so one rate-limited model does not quarantine the rest. OpenCode and Claude model aliases resolve through `router_config.json`, then pass an allowlist and cost check before execution. The router invokes their local CLIs with JSON output, captures response text and session ID, and records a named session only when the provider returns an ID. On resume, the saved engine and working directory are reused; OpenCode and Claude permit switching to another allowed model. CLI authentication and actual provider access are external prerequisites.

The per-engine health gate checks cached quota and circuit-breaker state before launching an engine. A failed response is classified; only eligible failures follow the engine-specific fallback order. Muse and Codex use their own CLIs. Gemini is a handoff to the parent Antigravity agent, not another API call by the router.

## Report contract

Every completed router invocation prints an `[AI FACTORY EXECUTION REPORT]` with `path`, `choices`, `errors`, and `succeed_with`. `path` starts with `gemini` as the caller label and includes only engines attempted **inside that invocation**. It cannot reconstruct earlier independent router calls. `[OK]` on a Gemini handoff means delegation occurred; the parent agent must still complete and verify the task. Callers should quote the report rather than infer success from a model's prose.

The interactive HTML diagrams are self-contained. Their editable sources are the adjacent JSON files, validated with Archify's showcase profile. Diagram text, guided views, and viewer controls are in English.
