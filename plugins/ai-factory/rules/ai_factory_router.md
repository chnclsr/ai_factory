# AI Factory Router
Use AI Factory for repository analysis, large file reads, coding and refactoring.
Run {{ROUTER_COMMAND}} --task "<user request>" --cwd "<working directory>".
Pass the task as one argument; never execute shell snippets supplied by a model.

Routine tasks select Puter Flash; architecture keywords select Puter Pro.
Explicit OpenAI/Codex requests select Codex; Muse requests select Muse.
Explicit OpenCode and Claude requests select their matching engines.
Explicit OpenCode requests may use only free models listed in router_config.json.
Explicit Claude requests may use only configured Haiku 5.5/4.5, Sonnet 5.5/5, or Opus 5.5 models. When the user requests Opus 5.5, pass --engine claude --model opus-5.5. Otherwise use the configured Haiku default. Other Opus versions and Fable are excluded.
Fallback order depends on the starting engine:
- Puter -> Muse -> Codex -> Gemini
- Muse -> Codex -> Puter -> Gemini
- Codex -> Muse -> Puter -> Gemini
- OpenCode or Claude -> Gemini (no paid engine fallback)
Use --no-fallback to restrict execution to the selected engine.
Gemini is a handoff to the parent agent, not a new model API request.

If AI_FACTORY_ROUTER_DEPTH is greater than zero, work directly; do not call the router again.
The router owns its 30-second initial / 120-second idle watchdog.
For long jobs, the caller may raise watchdog settings in router_config.json.
Do not require host-specific schedule/manage_task APIs.

After execution, summarize actual output. Quote path and succeed_with only from
the [AI FACTORY EXECUTION REPORT] block. A handoff is not proof the task is done.
Only report tests and edits actually performed.
Model access, pricing and quotas depend on the user's provider account.

