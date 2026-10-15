# AI Factory architecture

[System diagram HTML](diagrams/ai-factory-architecture.html) · [Routing flow HTML](diagrams/ai-factory-routing.html)

The plugin's `PreInvocation` / `PreToolUse` hooks live in `plugins/ai-factory/hooks/`. They inject routing guidance and can steer repository analysis toward the local `router.mjs` CLI. The router itself lives in `src/router.mjs`; `router_config.json` is its engine/model and watchdog policy. Runtime files, including the named-session registry, stay under `.runtime/` unless `AI_FACTORY_DATA_DIR` is set.

## Routing policy

| Starting engine | Selection | Failure path (unless `--no-fallback`) |
|---|---|---|
| Puter | Default Flash; Pro for configured complexity keywords | Muse → Codex → Gemini handoff |
| Muse | Explicit or configured Muse keywords | Codex → Puter → Gemini handoff |
| Codex | Explicit or configured Codex keywords | Muse → Puter → Gemini handoff |
| OpenCode | Explicit or OpenCode keywords; only free allowlisted models | Gemini handoff |
| Claude | Explicit or Claude keywords; only configured Haiku/Sonnet models | Gemini handoff |

An explicit `--engine` wins over keyword selection. OpenCode and Claude model aliases resolve through `router_config.json`, then pass an allowlist and cost check before execution. The router invokes their local CLIs with JSON output, captures response text and session ID, and records a named session only when the provider returns an ID. On resume, the saved engine and working directory are reused; OpenCode and Claude permit switching to another allowed model. CLI authentication and actual provider access are external prerequisites.

The per-engine health gate checks cached quota and circuit-breaker state before launching an engine. A failed CLI response is classified; only eligible failures follow the engine-specific fallback order. Puter runs through `dsh` and the local bridge (`src/server.mjs`); Muse and Codex use their own CLIs. Gemini is a handoff to the parent Antigravity agent, not another API call by the router.

## Report contract

Every completed router invocation prints an `[AI FACTORY EXECUTION REPORT]` with `path`, `choices`, `errors`, and `succeed_with`. `path` starts with `gemini` as the caller label and includes only engines attempted **inside that invocation**. It cannot reconstruct earlier independent router calls. `[OK]` on a Gemini handoff means delegation occurred; the parent agent must still complete and verify the task. Callers should quote the report rather than infer success from a model's prose.

The interactive HTML diagrams are self-contained. Their editable sources are the adjacent JSON files, validated with Archify's showcase profile. Diagram copy is Turkish; fixed viewer controls and the HTML language fallback are English because the current viewer has no Turkish locale.
