---
name: ai-factory
description: Delegate repository analysis, large reads, coding and refactoring through the local AI Factory router.
---

# AI Factory
Run {{ROUTER_COMMAND}} --task "<request>" --cwd "<working directory>".

Options:
- Default: free fallback chain `deepseek-v4.1-flash-free` → `mimo-v2.6-flash-free` → `glm-5.3-flash-free` (OpenCode, free) → Muse `muse-spark-1.3-contributor` → Codex `gpt-6-luna`.
- --model <name>: use the named model first (engine is inferred); add --no-fallback to run only that model.
- Do not claim tests were run unless the execution output confirms them.
- --engine muse: contributor model.
- --engine codex --model gpt-6-luna|gpt-5.6-luna|gpt-5.6-terra: free-tier Codex models only (no Sol/Astra).
- --engine opencode --model <free-model>: OpenCode's configured free models; defaults to deepseek-v4.1-flash-free.
- --engine claude --model haiku-5.5|haiku-4.5|sonnet-5|sonnet-5.5|opus-5.5: configured Claude Code models; defaults to Haiku 5.5. Select Opus 5.5 only when the user explicitly requests it.
- --name <name>: save a named session.
- --resume <name> --task "<follow-up>": resume when the engine provides a session ID.
- --resume <name> --model <allowed-model> --task "<follow-up>": switch models in a saved OpenCode or Claude session.
- --quota: refresh quota information.
- --no-fallback: stop after the selected engine fails.

Read rules/ai_factory_router.md in this plugin for the complete policy.
For an explicit Opus 5.5 request, run {{ROUTER_COMMAND}} --engine claude --model opus-5.5 --no-fallback --task "<request>" --cwd "<working directory>". Use current router_config.json for model names, not `claude models` or remembered restrictions.
Claude delegation must use the router, including tasks stored in prompt files: read the file and pass its contents with --task. Do not invoke `claude -p` or `claude --print` directly from terminal tools; the router starts that child process itself.
Do not route recursively when AI_FACTORY_ROUTER_DEPTH is greater than zero.
For work expected to exceed 30 seconds, follow the AGY task-monitoring protocol in rules/ai_factory_router.md: launch asynchronously with `WaitMsBeforeAsync: 1000` (or 500), schedule checks at 30 (`TimerCondition=never`), 120, and 240 seconds, then every 120 seconds while active. Inspect task status/logs via `manage_task(status)` and cancel pending checks on completion.
A Gemini handoff requires the parent agent to finish the task.
Copy execution status only from the actual router report; do not invent success.

