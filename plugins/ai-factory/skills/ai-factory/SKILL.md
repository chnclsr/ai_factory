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
- --name <name>: save a named session.
- --resume <name> --task "<follow-up>": resume when the engine provides a session ID.
- --quota: refresh quota information.
- --no-fallback: stop after the selected engine fails.

Read rules/ai_factory_router.md in this plugin for the complete policy.
Do not route recursively when AI_FACTORY_ROUTER_DEPTH is greater than zero.
A Gemini handoff requires the parent agent to finish the task.
Copy execution status only from the actual router report; do not invent success.

