---
name: ai-factory
description: Delegate repository analysis, large reads, coding and refactoring through the local AI Factory router.
---

# AI Factory
Run {{ROUTER_COMMAND}} --task "<request>" --cwd "<working directory>".

Options:
- --engine puter --model flash: routine work.
- --engine puter --model pro: complex work.
- --engine muse: contributor model.
- --engine codex --model <available-model>: explicit Codex request.
- --engine opencode --model <free-model>: OpenCode's configured free models; defaults to deepseek-v4.1-flash-free.
- --engine claude --model haiku-5.5|haiku-4.5|sonnet-5|sonnet-5.5: Claude Code with the configured lower-cost models; defaults to Haiku 5.5.
- --name <name>: save a named session.
- --resume <name> --task "<follow-up>": resume when the engine provides a session ID.
- --resume <name> --model <allowed-model> --task "<follow-up>": switch models in a saved OpenCode or Claude session.
- --quota: refresh quota information.
- --no-fallback: stop after the selected engine fails.

Read rules/ai_factory_router.md in this plugin for the complete policy.
Do not route recursively when AI_FACTORY_ROUTER_DEPTH is greater than zero.
A Gemini handoff requires the parent agent to finish the task.
Copy execution status only from the actual router report; do not invent success.

